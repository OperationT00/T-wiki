import type { ParseIssue, ParsePayload } from "../../types";
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { issue, normalizeMarkdownBody } from "../normalizer";
import {
  OcrRequiredError,
  ParserError,
  numericOption,
  throwIfAborted,
  type DocumentParser,
  type ParseContext,
  type ParseInput,
  type ProbeResult
} from "../parser-types";

interface PdfTextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
  hasEOL?: boolean;
}

interface PositionedItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  hasEOL: boolean;
}

interface ReconstructedLine {
  text: string;
  x: number;
  y: number;
  maxX: number;
  fontSize: number;
  forcedBreak: boolean;
}

interface PageLayout {
  page: number;
  width: number;
  height: number;
  lines: ReconstructedLine[];
  hasImage: boolean;
  characterCount: number;
}

export class PdfParser implements DocumentParser {
  readonly descriptor = {
    id: "pdfjs-layout",
    version: "1.0.0",
    execution: "local",
    supportedKinds: ["pdf"],
    capabilities: { sourceMap: true, assets: false, resumable: false }
  } as const;

  validateOptions(options: Readonly<Record<string, unknown>>): void {
    for (const [key, fallback, minimum] of [
      ["maxPdfPages", 1000, 1],
      ["maxPdfTextItems", 2_000_000, 1],
      ["lineYToleranceRatio", 0.35, 0.01],
      ["scannedPageMinChars", 40, 0],
      ["repeatedMarginTextPageRatio", 0.6, 0.01]
    ] as const) {
      const value = numericOption(options, key, fallback);
      if (!Number.isFinite(value) || value < minimum) {
        throw new ParserError("INVALID_PARSER_OPTIONS", `${key} 配置无效`);
      }
      if (key === "repeatedMarginTextPageRatio" && value > 1) {
        throw new ParserError("INVALID_PARSER_OPTIONS", `${key} 必须小于等于 1`);
      }
    }
  }

  probe(input: ParseInput): ProbeResult {
    const header = new TextDecoder("ascii").decode(input.bytes.subarray(0, 5));
    const magic = header === "%PDF-";
    return {
      supported: magic,
      confidence: magic ? 1 : 0,
      detectedMime: magic ? "application/pdf" : undefined,
      reason: magic ? undefined : "缺少 PDF magic bytes"
    };
  }

  async parse(input: ParseInput, context: ParseContext): Promise<ParsePayload> {
    if (!this.probe(input).supported) throw new ParserError("UNSUPPORTED_FORMAT", "文件不是有效的 PDF");
    throwIfAborted(context.signal);
    const maxPdfPages = numericOption(context.options, "maxPdfPages", 1000);
    const maxPdfTextItems = numericOption(context.options, "maxPdfTextItems", 2_000_000);
    const lineYToleranceRatio = numericOption(context.options, "lineYToleranceRatio", 0.35);
    const scannedPageMinChars = numericOption(context.options, "scannedPageMinChars", 40);
    const repeatedMarginTextPageRatio = numericOption(context.options, "repeatedMarginTextPageRatio", 0.6);
    const timeoutMs = numericOption(context.options, "timeoutMs", 120_000);
    const deadline = Date.now() + timeoutMs;
    configurePdfJsWorker();
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: input.bytes, disableWorker: true } as any);
    let document: any;
    try {
      document = await withTimeout(task.promise, remainingTimeout(deadline));
    } catch (error) {
      if (error instanceof ParserError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/password/i.test(message)) throw new ParserError("PDF_ENCRYPTED", "PDF 已加密或需要密码");
      if (/timeout/i.test(message)) throw new ParserError("PARSE_TIMEOUT", "PDF 打开超时", true);
      throw new ParserError("PDF_OPEN_FAILED", `PDF 打开失败：${message}`, true);
    }
    if (document.numPages > maxPdfPages) {
      throw new ParserError("PDF_PAGE_LIMIT", `PDF 页数 ${document.numPages} 超过限制 ${maxPdfPages}`);
    }

    const pages: PageLayout[] = [];
    const issues: ParseIssue[] = [];
    const ocrPages: number[] = [];
    let totalItems = 0;
    let omittedImageCount = 0;
    context.reportProgress({
      phase: "parsing",
      completed: 0,
      total: document.numPages,
      unit: "page",
      message: `准备解析 ${document.numPages} 页 PDF`
    });
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      throwIfAborted(context.signal);
      const page = await withTimeout<any>(document.getPage(pageNumber), remainingTimeout(deadline));
      const [textContent, operatorList] = await withTimeout<[any, any]>(
        Promise.all([page.getTextContent(), page.getOperatorList()]),
        remainingTimeout(deadline)
      );
      const viewport = page.getViewport({ scale: 1 });
      const textItems = textContent.items.filter(isPdfTextItem);
      totalItems += textItems.length;
      if (totalItems > maxPdfTextItems) {
        throw new ParserError(
          "PDF_TEXT_ITEM_LIMIT",
          `PDF 文本项超过限制 ${maxPdfTextItems}`
        );
      }
      const hasImage = containsImageOperation(operatorList.fnArray, pdfjs.OPS);
      const lines = reconstructPdfLines(textItems, lineYToleranceRatio);
      const characterCount = lines.reduce((sum, line) => sum + visibleCharacters(line.text), 0);
      if (hasImage) omittedImageCount += 1;
      if (isOcrCandidate(characterCount, hasImage, scannedPageMinChars)) {
        ocrPages.push(pageNumber);
      }
      pages.push({
        page: pageNumber,
        width: viewport.width,
        height: viewport.height,
        lines,
        hasImage,
        characterCount
      });
      context.reportProgress({
        phase: "parsing",
        completed: pageNumber,
        total: document.numPages,
        unit: "page",
        message: `已解析 ${pageNumber}/${document.numPages} 页`
      });
    }
    if (ocrPages.length > 0) throw new OcrRequiredError(ocrPages);

    removeRepeatedMargins(pages, repeatedMarginTextPageRatio);
    const bodyParts: string[] = [];
    let parsedPageCount = 0;
    for (const page of pages) {
      if (page.lines.length === 0) {
        bodyParts.push("");
        continue;
      }
      parsedPageCount += 1;
      const layout = pageToMarkdown(page);
      bodyParts.push(layout.markdown);
      issues.push(...layout.issues);
      if (page.hasImage) {
        issues.push({
          ...issue("PDF_IMAGE_OMITTED", `第 ${page.page} 页包含未提取图片`),
          source: { page: page.page }
        });
      }
    }
    const body = normalizeMarkdownBody(bodyParts.join("\n\n"));
    const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
    return {
      schemaVersion: 2,
      metadata: title ? { title } : {},
      markdown: body,
      assets: [],
      issues,
      stats: {
        pageCount: pages.length,
        parsedPageCount,
        ocrPageCount: 0,
        omittedImageCount,
        tableCount: 0
      }
    };
  }
}

function configurePdfJsWorker(): void {
  const runtime = globalThis as typeof globalThis & {
    pdfjsWorker?: { WorkerMessageHandler: unknown };
  };
  runtime.pdfjsWorker ??= { WorkerMessageHandler };
}

export function reconstructPdfLines(
  items: PdfTextItemLike[],
  toleranceRatio = 0.35
): ReconstructedLine[] {
  const positioned = items
    .map(toPositioned)
    .filter((item) => item.text.trim())
    .sort((a, b) => Math.abs(b.y - a.y) > 0.5 ? b.y - a.y : a.x - b.x);
  if (positioned.length === 0) return [];
  const medianHeight = median(positioned.map((item) => item.fontSize || item.height || 10)) || 10;
  const tolerance = Math.max(1.5, medianHeight * toleranceRatio);
  const groups: PositionedItem[][] = [];
  for (const item of positioned) {
    const group = groups.find((candidate) => Math.abs(candidate[0]!.y - item.y) <= tolerance);
    if (group) group.push(item);
    else groups.push([item]);
  }
  groups.sort((a, b) => b[0]!.y - a[0]!.y);
  return groups.map((group) => {
    group.sort((a, b) => a.x - b.x);
    let text = "";
    let previous: PositionedItem | undefined;
    for (const item of group) {
      if (previous) {
        const gap = item.x - (previous.x + previous.width);
        const averageCharacterWidth = previous.width / Math.max(1, [...previous.text].length);
        if (gap > Math.max(1.5, averageCharacterWidth * 0.65) && shouldInsertSpace(previous.text, item.text)) {
          text += " ";
        }
      }
      text += item.text;
      previous = item;
    }
    const first = group[0]!;
    const last = group.at(-1)!;
    return {
      text: text.replace(/\s+/g, " ").trim(),
      x: first.x,
      y: median(group.map((item) => item.y)),
      maxX: last.x + last.width,
      fontSize: median(group.map((item) => item.fontSize)),
      forcedBreak: group.some((item) => item.hasEOL)
    };
  }).filter((line) => line.text);
}

export function isOcrCandidate(characterCount: number, hasImage: boolean, minimumCharacters: number): boolean {
  return hasImage && characterCount < minimumCharacters;
}

function pageToMarkdown(page: PageLayout): {
  markdown: string;
  issues: ParseIssue[];
} {
  const issues: ParseIssue[] = [];
  const multiColumn = looksMultiColumn(page.lines, page.width);
  const lines = multiColumn ? orderTwoColumns(page.lines, page.width) : page.lines;
  const fontMedian = median(lines.map((line) => line.fontSize)) || 10;
  if (multiColumn) {
    issues.push({
      ...issue("PDF_MULTI_COLUMN_LAYOUT", `第 ${page.page} 页疑似双栏，已按左栏后右栏恢复阅读顺序`),
      source: { page: page.page }
    });
  }
  const output: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    const text = joinParagraphLines(paragraph);
    paragraph = [];
    if (!text) return;
    output.push(text, "");
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const next = lines[index + 1];
    const headingLevel = inferredHeadingLevel(line, fontMedian);
    if (headingLevel) {
      flush();
      output.push(`${"#".repeat(headingLevel)} ${line.text}`, "");
      continue;
    }
    if (isListLine(line.text)) {
      flush();
      const cleaned = line.text.replace(/^\s*([•●▪◦‣]|[-*+]|\d+[.)、])\s*/, "");
      const ordered = /^\s*\d+[.)、]/.test(line.text);
      output.push(`${ordered ? "1." : "-"} ${cleaned}`);
      if (!next || !isListLine(next.text)) output.push("");
      continue;
    }
    paragraph.push(line.text);
    const verticalGap = next ? Math.abs(line.y - next.y) : Number.POSITIVE_INFINITY;
    const gapBreak = next ? verticalGap > Math.max(line.fontSize, next.fontSize) * 1.65 : true;
    if (line.forcedBreak && (sentenceEnds(line.text) || gapBreak)) flush();
    else if (gapBreak) flush();
  }
  flush();
  return { markdown: output.join("\n").trim(), issues };
}

function toPositioned(item: PdfTextItemLike): PositionedItem {
  const transform = item.transform;
  const fontSize = Math.max(
    item.height || 0,
    Math.hypot(transform[2] ?? 0, transform[3] ?? 0),
    1
  );
  return {
    text: String(item.str ?? ""),
    x: Number(transform[4] ?? 0),
    y: Number(transform[5] ?? 0),
    width: Math.max(0, Number(item.width ?? 0)),
    height: Math.max(0, Number(item.height ?? fontSize)),
    fontSize,
    hasEOL: Boolean(item.hasEOL)
  };
}

function isPdfTextItem(value: unknown): value is PdfTextItemLike {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PdfTextItemLike>;
  return typeof item.str === "string" && Array.isArray(item.transform);
}

function containsImageOperation(fnArray: number[], ops: Record<string, number>): boolean {
  const imageOps = new Set([
    ops.paintImageMaskXObject,
    ops.paintImageMaskXObjectGroup,
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintInlineImageXObjectGroup,
    ops.paintImageXObjectRepeat,
    ops.paintImageMaskXObjectRepeat
  ].filter((value): value is number => typeof value === "number"));
  return fnArray.some((value) => imageOps.has(value));
}

function removeRepeatedMargins(pages: PageLayout[], ratio: number): void {
  if (pages.length < 3) return;
  const counts = new Map<string, number>();
  for (const page of pages) {
    const candidates = [page.lines[0], page.lines.at(-1)].filter(Boolean) as ReconstructedLine[];
    for (const line of candidates) {
      const key = normalizeMarginText(line.text);
      if (key && key.length <= 120) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const repeated = new Set([...counts.entries()]
    .filter(([, count]) => count / pages.length >= ratio)
    .map(([key]) => key));
  if (repeated.size === 0) return;
  for (const page of pages) {
    page.lines = page.lines.filter((line, index) => {
      if (index !== 0 && index !== page.lines.length - 1) return true;
      return !repeated.has(normalizeMarginText(line.text));
    });
  }
}

function looksMultiColumn(lines: ReconstructedLine[], pageWidth: number): boolean {
  if (lines.length < 8 || pageWidth <= 0) return false;
  const center = pageWidth / 2;
  const left = lines.filter((line) => line.maxX < center * 1.05).length;
  const right = lines.filter((line) => line.x > center * 0.95).length;
  return left >= 3 && right >= 3 && (left + right) / lines.length >= 0.6;
}

function orderTwoColumns(lines: ReconstructedLine[], pageWidth: number): ReconstructedLine[] {
  const center = pageWidth / 2;
  const left = lines.filter((line) => line.maxX < center * 1.05).sort((a, b) => b.y - a.y);
  const right = lines.filter((line) => line.x > center * 0.95).sort((a, b) => b.y - a.y);
  const spanning = lines
    .filter((line) => !left.includes(line) && !right.includes(line))
    .sort((a, b) => b.y - a.y);
  const output: ReconstructedLine[] = [];
  let upper = Number.POSITIVE_INFINITY;
  for (const boundary of spanning) {
    output.push(
      ...left.filter((line) => line.y < upper && line.y > boundary.y),
      ...right.filter((line) => line.y < upper && line.y > boundary.y),
      boundary
    );
    upper = boundary.y;
  }
  output.push(
    ...left.filter((line) => line.y < upper),
    ...right.filter((line) => line.y < upper)
  );
  return output;
}

function inferredHeadingLevel(line: ReconstructedLine, medianFont: number): 1 | 2 | 3 | null {
  if (line.text.length > 100) return null;
  if (line.fontSize >= medianFont * 1.7) return 1;
  if (line.fontSize >= medianFont * 1.35) return 2;
  if (/^(?:第[一二三四五六七八九十百]+[章节]|[一二三四五六七八九十]+、)/.test(line.text)) return 2;
  return null;
}

function joinParagraphLines(lines: string[]): string {
  let output = "";
  for (const line of lines) {
    if (!output) {
      output = line;
      continue;
    }
    if (/[A-Za-z0-9]$/.test(output) && /^[A-Za-z0-9]/.test(line)) output += ` ${line}`;
    else output += line;
  }
  return output.trim();
}

function shouldInsertSpace(left: string, right: string): boolean {
  const a = left.at(-1) ?? "";
  const b = right[0] ?? "";
  return /[A-Za-z0-9)]/.test(a) || /[A-Za-z0-9(]/.test(b);
}

function isListLine(text: string): boolean {
  return /^\s*(?:[•●▪◦‣]|[-*+]|\d+[.)、])\s*/.test(text);
}

function sentenceEnds(text: string): boolean {
  return /[。！？.!?；;：:]$/.test(text);
}

function normalizeMarginText(text: string): string {
  return text.toLocaleLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

function visibleCharacters(text: string): number {
  return [...text.replace(/\s/g, "")].length;
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ParserError("PARSE_TIMEOUT", "PDF 解析超时", true)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ParserError("PARSE_TIMEOUT", "PDF 解析超时", true);
  return remaining;
}
