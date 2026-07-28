export const MANAGED_RELATED_START = "<!-- llm-wiki:related:start -->";
export const MANAGED_RELATED_END = "<!-- llm-wiki:related:end -->";

const MANAGED_RELATED = /(?:\r?\n)*<!-- llm-wiki:related:start -->[\s\S]*?<!-- llm-wiki:related:end -->(?:\r?\n)*/g;
const WIKILINK = /^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/;

export function normalizeRelatedTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const wikilink = trimmed.match(WIKILINK);
  const raw = wikilink?.[1] ?? (trimmed.startsWith("wiki/") ? trimmed : "");
  if (!raw) return null;
  const normalized = raw.trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/").replace(/\.md$/i, "");
  if (!normalized.startsWith("wiki/") || normalized.includes("../")) return null;
  return normalized;
}

export function normalizeRelatedTargets(values: Iterable<unknown>): string[] {
  const result = new Set<string>();
  for (const value of values) {
    const target = normalizeRelatedTarget(value);
    if (target) result.add(target);
  }
  return [...result];
}

export function hasManagedRelatedSection(body: string): boolean {
  return body.includes(MANAGED_RELATED_START) && body.includes(MANAGED_RELATED_END);
}

export function managedRelatedTargets(body: string): string[] {
  const start = body.indexOf(MANAGED_RELATED_START);
  const end = body.indexOf(MANAGED_RELATED_END, start + MANAGED_RELATED_START.length);
  if (start < 0 || end < 0) return [];
  const section = body.slice(start + MANAGED_RELATED_START.length, end);
  const matches = section.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g);
  return normalizeRelatedTargets([...matches].map((match) => match[1]));
}

export function stripManagedRelatedSection(body: string): string {
  return body.replace(MANAGED_RELATED, "\n").trimEnd();
}

export function renderManagedRelatedBody(body: string, targets: Iterable<unknown>): string {
  const base = stripManagedRelatedSection(body);
  const related = normalizeRelatedTargets(targets);
  if (related.length === 0) return `${base}\n`;
  const section = [
    MANAGED_RELATED_START,
    "## 关联条目",
    "",
    ...related.map((target) => `- [[${target}]]`),
    MANAGED_RELATED_END
  ].join("\n");
  return `${base}\n\n${section}\n`;
}
