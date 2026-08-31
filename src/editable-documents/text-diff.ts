import { sha256 } from "../core/wiki-core";

import type { DiffLine, TextDiff, TextDiffHunk } from "./types";

const MAX_LCS_CELLS = 2_000_000;

export function computeTextDiff(beforeInput: string, afterInput: string, contextLines = 3): TextDiff {
  const before = normalizeNewlines(beforeInput);
  const after = normalizeNewlines(afterInput);
  if (before === after) {
    return {
      beforeHash: sha256(before),
      afterHash: sha256(after),
      addedLines: 0,
      removedLines: 0,
      hunks: [],
      truncated: false
    };
  }
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const exact = oldLines.length * newLines.length <= MAX_LCS_CELLS;
  const operations = exact
    ? lcsOperations(oldLines, newLines)
    : boundedOperations(oldLines, newLines);
  const numbered = numberOperations(operations);
  return {
    beforeHash: sha256(before),
    afterHash: sha256(after),
    addedLines: numbered.filter((line) => line.type === "add").length,
    removedLines: numbered.filter((line) => line.type === "remove").length,
    hunks: buildHunks(numbered, Math.max(0, Math.min(20, Math.round(contextLines)))),
    truncated: !exact
  };
}

export function renderUnifiedDiff(diff: TextDiff): string {
  if (diff.hunks.length === 0) return "(no changes)";
  return diff.hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines.map((line) => `${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.text}`)
  ]).join("\n");
}

interface Operation {
  type: DiffLine["type"];
  text: string;
}

function lcsOperations(oldLines: string[], newLines: string[]): Operation[] {
  const width = newLines.length + 1;
  const matrix = new Uint32Array((oldLines.length + 1) * width);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const offset = oldIndex * width + newIndex;
      matrix[offset] = oldLines[oldIndex] === newLines[newIndex]
        ? matrix[(oldIndex + 1) * width + newIndex + 1]! + 1
        : Math.max(matrix[(oldIndex + 1) * width + newIndex]!, matrix[offset + 1]!);
    }
  }
  const output: Operation[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length
      && oldLines[oldIndex] === newLines[newIndex]) {
      output.push({ type: "context", text: oldLines[oldIndex]! });
      oldIndex += 1;
      newIndex += 1;
    } else if (newIndex < newLines.length
      && (oldIndex >= oldLines.length
        || matrix[oldIndex * width + newIndex + 1]! >= matrix[(oldIndex + 1) * width + newIndex]!)) {
      output.push({ type: "add", text: newLines[newIndex]! });
      newIndex += 1;
    } else {
      output.push({ type: "remove", text: oldLines[oldIndex]! });
      oldIndex += 1;
    }
  }
  return output;
}

function boundedOperations(oldLines: string[], newLines: string[]): Operation[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) {
    suffix += 1;
  }
  return [
    ...oldLines.slice(0, prefix).map((text) => ({ type: "context" as const, text })),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((text) => ({ type: "remove" as const, text })),
    ...newLines.slice(prefix, newLines.length - suffix).map((text) => ({ type: "add" as const, text })),
    ...oldLines.slice(oldLines.length - suffix).map((text) => ({ type: "context" as const, text }))
  ];
}

function numberOperations(operations: Operation[]): DiffLine[] {
  let oldLine = 1;
  let newLine = 1;
  return operations.map((operation) => {
    const line: DiffLine = {
      ...operation,
      ...(operation.type !== "add" ? { oldLine } : {}),
      ...(operation.type !== "remove" ? { newLine } : {})
    };
    if (operation.type !== "add") oldLine += 1;
    if (operation.type !== "remove") newLine += 1;
    return line;
  });
}

function buildHunks(lines: DiffLine[], context: number): TextDiffHunk[] {
  const changes = lines.flatMap((line, index) => line.type === "context" ? [] : [index]);
  if (changes.length === 0) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changes) {
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length, index + context + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  return ranges.map(({ start, end }) => {
    const selected = lines.slice(start, end);
    const oldStart = selected.find((line) => line.oldLine !== undefined)?.oldLine
      ?? previousLine(lines, start, "oldLine") + 1;
    const newStart = selected.find((line) => line.newLine !== undefined)?.newLine
      ?? previousLine(lines, start, "newLine") + 1;
    return {
      oldStart,
      oldLines: selected.filter((line) => line.type !== "add").length,
      newStart,
      newLines: selected.filter((line) => line.type !== "remove").length,
      lines: selected
    };
  });
}

function previousLine(lines: DiffLine[], start: number, key: "oldLine" | "newLine"): number {
  for (let index = start - 1; index >= 0; index -= 1) {
    const value = lines[index]?.[key];
    if (value !== undefined) return value;
  }
  return 0;
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}
