import { estimateTokens } from "./context-budget";

export interface MarkdownSection {
  sectionId: string;
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  estimatedTokens: number;
  page?: number;
  content: string;
}

/**
 * Builds a deterministic section outline shared by Agent tools and host-side
 * incremental Ingest. Section IDs are deliberately scoped to one immutable
 * Raw revision; callers that compare revisions must use heading occurrence
 * keys rather than assuming that an sNNNN ID survives insertions.
 */
export function markdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const starts: Array<{ line: number; heading: string; level: number; page?: number }> = [];
  let fenced = false;
  let page: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index]!)) fenced = !fenced;
    if (fenced) continue;
    const pageMarker = lines[index]!.match(/^<!--\s*llm-wiki:page=(\d+)\s*-->$/);
    if (pageMarker) page = Number(pageMarker[1]);
    const match = lines[index]!.match(/^(#{1,6})\s+(.+)$/);
    if (match) starts.push({ line: index, heading: match[2]!.trim(), level: match[1]!.length, page });
  }
  if (starts.length === 0 || starts[0]!.line > 0) {
    starts.unshift({ line: 0, heading: starts.length ? "Preamble" : "Document", level: 0 });
  }
  return starts.map((start, index) => {
    const endExclusive = starts[index + 1]?.line ?? lines.length;
    const content = lines.slice(start.line, endExclusive).join("\n").trimEnd();
    return {
      sectionId: `s${String(index + 1).padStart(4, "0")}`,
      heading: start.heading,
      level: start.level,
      startLine: start.line + 1,
      endLine: endExclusive,
      estimatedTokens: estimateTokens(content),
      page: start.page,
      content
    };
  });
}
