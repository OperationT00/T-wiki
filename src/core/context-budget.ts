const DEFAULT_COMPLETION_RESERVE = 32_000;
const MIN_INPUT_BUDGET = 8_000;

export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return nonAscii + Math.ceil(ascii / 4);
}

export function inputTokenBudget(contextWindow: number): number {
  const usable = Math.floor((contextWindow - DEFAULT_COMPLETION_RESERVE) * 0.8);
  return Math.max(MIN_INPUT_BUDGET, usable);
}

export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;

  let used = 0;
  let result = "";
  for (const character of text) {
    const cost = character.codePointAt(0)! <= 0x7f ? 0.25 : 1;
    if (used + cost > maxTokens) break;
    result += character;
    used += cost;
  }
  return result;
}

export function splitTextByTokenBudget(text: string, maxTokens: number): string[] {
  if (!text.trim()) return [];
  if (estimateTokens(text) <= maxTokens) return [text];

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (estimateTokens(candidate) <= maxTokens) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = "";

    let remainder = paragraph;
    while (estimateTokens(remainder) > maxTokens) {
      const part = truncateToTokenBudget(remainder, maxTokens);
      if (!part) break;
      chunks.push(part);
      remainder = remainder.slice(part.length);
    }
    current = remainder;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function splitMarkdownByTokenBudget(text: string, maxTokens: number): string[] {
  if (!text.trim()) return [];
  if (estimateTokens(text) <= maxTokens) return [text];
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    const boundary = /^(?:#{1,3}\s+|<!--\s*llm-wiki:page=\d+)/.test(line);
    if (boundary && current.some((entry) => entry.trim())) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.some((entry) => entry.trim())) sections.push(current.join("\n"));

  const chunks: string[] = [];
  let pending = "";
  for (const section of sections) {
    const candidate = pending ? `${pending}\n\n${section}` : section;
    if (estimateTokens(candidate) <= maxTokens) {
      pending = candidate;
      continue;
    }
    if (pending) chunks.push(pending);
    pending = "";
    if (estimateTokens(section) <= maxTokens) pending = section;
    else chunks.push(...splitTextByTokenBudget(section, maxTokens));
  }
  if (pending) chunks.push(pending);
  return chunks;
}
