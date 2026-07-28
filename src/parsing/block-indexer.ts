import type {
  ProvenanceHint,
  SourceKind,
  SourceLocator,
  SourceMapEntry
} from "../types";
import { sanitizeSourceUri } from "./source-uri";

export const BLOCK_MARKER = /^<!--\s*llm-wiki:block=(b\d{6})\s*-->$/;
export const PAGE_MARKER = /^<!--\s*llm-wiki:page=(\d+)(?:\s+source=\w+)?\s*-->$/;

export interface IndexedMarkdown {
  markdown: string;
  entries: SourceMapEntry[];
}

export function indexMarkdownBlocks(
  markdown: string,
  input: {
    kind: SourceKind;
    sourceUri?: string;
    hints?: ProvenanceHint[];
  }
): IndexedMarkdown {
  validateHints(input.hints);
  const lines = markdown.replace(/\n$/, "").split("\n");
  const output: string[] = [];
  const entries: SourceMapEntry[] = [];
  let index = 0;
  let blockOrdinal = 0;
  let currentPage = 1;

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      output.push(line);
      index += 1;
      continue;
    }
    const page = line.trim().match(PAGE_MARKER);
    if (page?.[1]) {
      currentPage = Number(page[1]);
      output.push(line);
      index += 1;
      continue;
    }
    if (BLOCK_MARKER.test(line.trim())) {
      index += 1;
      continue;
    }

    const block = readBlock(lines, index);
    blockOrdinal += 1;
    const blockId = `b${String(blockOrdinal).padStart(6, "0")}`;
    output.push(`<!-- llm-wiki:block=${blockId} -->`);
    const rawStartLine = output.length + 1;
    output.push(...block.lines);
    const rawEndLine = output.length;
    const sourceStartLine = index + 1;
    const sourceEndLine = block.end + 1;
    entries.push({
      blockId,
      type: block.type,
      raw: { startLine: rawStartLine, endLine: rawEndLine },
      source: resolveLocator(
        input.kind,
        input.sourceUri,
        currentPage,
        sourceStartLine,
        sourceEndLine,
        input.hints
      )
    });
    index = block.end + 1;
  }

  return {
    markdown: `${output.join("\n").trim()}\n`,
    entries
  };
}

function validateHints(hints: ProvenanceHint[] | undefined): void {
  for (const hint of hints ?? []) {
    if (!Number.isInteger(hint.output.startLine)
      || !Number.isInteger(hint.output.endLine)
      || hint.output.startLine < 1
      || hint.output.endLine < hint.output.startLine) {
      throw new Error("PROVENANCE_HINT_RANGE_INVALID");
    }
    if (hint.source.kind === "pdf" && (!Number.isInteger(hint.source.page) || hint.source.page < 1)) {
      throw new Error("PROVENANCE_HINT_PAGE_INVALID");
    }
    if (hint.source.kind === "text"
      && (hint.source.startLine < 1 || hint.source.endLine < hint.source.startLine)) {
      throw new Error("PROVENANCE_HINT_LINE_INVALID");
    }
    if (hint.source.kind === "pdf" && hint.source.bbox
      && (hint.source.bbox.length !== 4 || hint.source.bbox.some((value) => !Number.isFinite(value)))) {
      throw new Error("PROVENANCE_HINT_BBOX_INVALID");
    }
  }
}

function readBlock(
  lines: string[],
  start: number
): {
  type: SourceMapEntry["type"];
  lines: string[];
  end: number;
} {
  const first = lines[start]!;
  const fence = first.match(/^\s*(```+|~~~+)/)?.[1];
  if (fence) {
    const marker = fence[0]!;
    let end = start + 1;
    while (end < lines.length && !new RegExp(`^\\s*${escapeRegex(marker)}{${fence.length},}\\s*$`).test(lines[end]!)) {
      end += 1;
    }
    if (end >= lines.length) end = lines.length - 1;
    return { type: "code", lines: lines.slice(start, end + 1), end };
  }
  if (/^#{1,6}\s+/.test(first)) {
    return { type: "heading", lines: [first], end: start };
  }
  if (isTableStart(lines, start)) {
    let end = start + 2;
    while (end < lines.length && /^\s*\|?.*\|.*\|?\s*$/.test(lines[end]!) && lines[end]!.trim()) end += 1;
    return { type: "table", lines: lines.slice(start, end), end: end - 1 };
  }
  if (/^\s*(?:[-*+]\s+|\d+[.)、]\s+)/.test(first)) {
    let end = start + 1;
    while (end < lines.length) {
      const candidate = lines[end]!;
      if (!candidate.trim()
        || PAGE_MARKER.test(candidate.trim())
        || /^#{1,6}\s+/.test(candidate)
        || /^\s*(```+|~~~+)/.test(candidate)
        || /^\s*>/.test(candidate)
        || isTableStart(lines, end)) break;
      if (/^\s*(?:[-*+]\s+|\d+[.)、]\s+|\s{2,}\S)/.test(candidate)) end += 1;
      else break;
    }
    return { type: "list", lines: lines.slice(start, end), end: end - 1 };
  }
  if (/^\s*>/.test(first)) {
    let end = start + 1;
    while (end < lines.length && /^\s*>/.test(lines[end]!)) end += 1;
    return { type: "quote", lines: lines.slice(start, end), end: end - 1 };
  }
  if (/^\s*<!--/.test(first) || /^\s*<[/A-Za-z]/.test(first)) {
    return { type: "html", lines: [first], end: start };
  }
  let end = start + 1;
  while (end < lines.length) {
    const candidate = lines[end]!;
    if (!candidate.trim() || PAGE_MARKER.test(candidate.trim()) || BLOCK_MARKER.test(candidate.trim())
      || isStructuralStart(candidate) || isTableStart(lines, end)) break;
    end += 1;
  }
  return { type: "paragraph", lines: lines.slice(start, end), end: end - 1 };
}

function resolveLocator(
  kind: SourceKind,
  sourceUri: string | undefined,
  page: number,
  startLine: number,
  endLine: number,
  hints: ProvenanceHint[] | undefined
): SourceLocator {
  const hint = hints?.find((candidate) =>
    candidate.output.startLine <= startLine && candidate.output.endLine >= startLine
  );
  if (hint) {
    return hint.source.kind === "web"
      ? { ...hint.source, url: sanitizeSourceUri(hint.source.url) }
      : hint.source;
  }
  if (kind === "pdf") return { kind: "pdf", page };
  if (kind === "web") return { kind: "web", url: sanitizeSourceUri(sourceUri) };
  return { kind: "text", startLine, endLine };
}

function isStructuralStart(line: string): boolean {
  return /^#{1,6}\s+/.test(line)
    || /^\s*(```+|~~~+)/.test(line)
    || /^\s*(?:[-*+]\s+|\d+[.)、]\s+)/.test(line)
    || /^\s*>/.test(line);
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  const separator = lines[index + 1];
  return Boolean(
    header?.includes("|")
    && separator
    && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator)
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
