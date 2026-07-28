import type { ParseIssue, ParsePayload, ParseQuality } from "../types";
import { ParserError } from "./parser-types";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export function decodeText(bytes: Uint8Array, allowUtf16 = true): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3));
  }
  if (allowUtf16 && bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
  }
  if (allowUtf16 && bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1]!;
      swapped[index - 1] = bytes[index]!;
    }
    return new TextDecoder("utf-16le", { fatal: true }).decode(swapped);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ParserError("UNSUPPORTED_ENCODING", "文本不是有效的 UTF-8/UTF-16 编码");
  }
}

export function normalizeMarkdownBody(input: string): string {
  const normalized = input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .replace(CONTROL_CHARACTERS, "");
  const output: string[] = [];
  let inFence = false;
  let blankCount = 0;
  for (const rawLine of normalized.split("\n")) {
    const fence = rawLine.match(/^\s*(```+|~~~+)/);
    if (fence) inFence = !inFence;
    const line = inFence ? rawLine.replace(/[ \t]+$/, "") : rawLine.trimEnd();
    if (!line.trim()) {
      blankCount += 1;
      if (blankCount <= 2) output.push("");
      continue;
    }
    blankCount = 0;
    if (!inFence && line.length > 1200) output.push(...wrapLongLine(line, 1200));
    else output.push(line);
  }
  return `${output.join("\n").trim()}\n`;
}

export function assessQuality(
  document: ParsePayload,
  body: string,
  config: { maxOutputBytes: number },
  blockCount: number
): ParseQuality {
  const characters = [...body];
  const replacementCount = characters.filter((value) => value === "\uFFFD").length;
  const replacementCharacterRatio = replacementCount / Math.max(1, characters.length);
  const lines = body.split("\n");
  const veryLongLineCount = lines.filter((line) => line.length > 2000).length;
  const pageCount = document.stats?.pageCount;
  const emptyPageRatio = pageCount
    ? Math.max(0, pageCount - (document.stats?.parsedPageCount ?? pageCount)) / pageCount
    : undefined;
  const errors: string[] = [];
  if (!body.trim()) errors.push("正文为空");
  if (replacementCharacterRatio > 0.01) errors.push("替换字符比例超过 1%");
  if (veryLongLineCount > 0) errors.push("存在超过 2000 字符的行");
  if (emptyPageRatio !== undefined && emptyPageRatio > 0.3) errors.push("PDF 空白页比例超过 30%");
  if (new TextEncoder().encode(body).byteLength > config.maxOutputBytes) errors.push("解析产物超过大小限制");
  if (!fencesBalanced(body)) errors.push("Markdown 代码围栏未闭合");
  if (errors.length > 0) {
    throw new ParserError("QUALITY_GATE_FAILED", errors.join("；"), false, {
      replacementCharacterRatio,
      veryLongLineCount,
      pageCount: pageCount ?? 0
    });
  }
  const warnings = document.issues.filter((issue) => issue.severity === "warning").length;
  const warningQuality = replacementCharacterRatio > 0.001
    || (emptyPageRatio !== undefined && emptyPageRatio > 0.1)
    || warnings > 0;
  return {
    pageCount,
    parsedPageCount: document.stats?.parsedPageCount,
    ocrPageCount: document.stats?.ocrPageCount,
    characterCount: characters.length,
    blockCount,
    replacementCharacterRatio,
    emptyPageRatio,
    veryLongLineCount,
    omittedImageCount: document.stats?.omittedImageCount ?? 0,
    tableCount: document.stats?.tableCount ?? 0,
    overall: warningQuality ? "warning" : "pass"
  };
}

export function issue(code: string, message: string): ParseIssue {
  return { code, severity: "warning", message };
}

function wrapLongLine(line: string, limit: number): string[] {
  const output: string[] = [];
  let rest = line;
  while (rest.length > limit) {
    let split = rest.lastIndexOf(" ", limit);
    if (split < Math.floor(limit * 0.6)) split = limit;
    output.push(rest.slice(0, split).trimEnd());
    rest = rest.slice(split).trimStart();
  }
  if (rest) output.push(rest);
  return output;
}

function fencesBalanced(body: string): boolean {
  let active: string | null = null;
  for (const line of body.split("\n")) {
    const match = line.match(/^\s*(```+|~~~+)/);
    if (!match?.[1]) continue;
    const marker = match[1][0]!;
    if (!active) active = marker;
    else if (active === marker) active = null;
  }
  return active === null;
}
