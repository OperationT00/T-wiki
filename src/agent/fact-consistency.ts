import type { EvidenceClaim } from "../types";

export interface NumericFact {
  text: string;
  value: number;
  unit: string;
  qualifier: "exact" | "approx" | "min" | "max" | "greater" | "less";
  context: string;
}

export interface NumericFactValidation {
  errors: string[];
  warnings: string[];
}

const NUMBER = /(?:约|大约|近|至少|最少|不低于|超过|大于|最多|至多|不超过|少于|小于)?\s*(?:为|是|达到|达)?\s*-?\d+(?:\.\d+)?\s*(?:%|％|毫秒|ms|秒|s|分钟|分|小时|h|天|B|KB|KiB|MB|MiB|GB|GiB|TB|个|次|项|页|条|年|月|日)?/giu;
const UNIT_ALIASES: Record<string, string> = {
  "％": "%", ms: "ms", 毫秒: "ms", s: "s", 秒: "s", 分: "min", 分钟: "min",
  h: "h", 小时: "h", B: "B", KB: "KB", KiB: "KiB", MB: "MB", MiB: "MiB",
  GB: "GB", GiB: "GiB", TB: "TB"
};
const SCALES: Record<string, { family: string; scale: number }> = {
  "%": { family: "ratio", scale: 0.01 }, ms: { family: "time", scale: 0.001 },
  s: { family: "time", scale: 1 }, min: { family: "time", scale: 60 }, h: { family: "time", scale: 3600 },
  B: { family: "bytes", scale: 1 }, KB: { family: "bytes", scale: 1000 }, KiB: { family: "bytes", scale: 1024 },
  MB: { family: "bytes", scale: 1_000_000 }, MiB: { family: "bytes", scale: 1_048_576 },
  GB: { family: "bytes", scale: 1_000_000_000 }, GiB: { family: "bytes", scale: 1_073_741_824 },
  TB: { family: "bytes", scale: 1_000_000_000_000 }
};

/** Extracts local numeric facts without persisting or indexing source content. */
export function extractNumericFacts(input: string): NumericFact[] {
  const text = stripNonProse(input);
  const facts: NumericFact[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const raw = match[0].trim();
    const index = match.index ?? 0;
    const numeric = raw.match(/-?\d+(?:\.\d+)?/u)?.[0];
    if (!numeric || isStructuralNumber(text, index, raw)) continue;
    const unitRaw = raw.slice(raw.indexOf(numeric) + numeric.length).trim();
    const unit = UNIT_ALIASES[unitRaw] ?? unitRaw;
    facts.push({
      text: raw,
      value: Number(numeric),
      unit,
      qualifier: qualifierOf(raw),
      context: factContext(text, index, index + match[0].length)
    });
  }
  return facts;
}

/** Validates a model claim against its verbatim supporting quote. */
export function validateClaimNumericConsistency(
  claim: string,
  supportingQuote: string,
  relation: EvidenceClaim["relation"]
): NumericFactValidation {
  if (relation !== "supports") return { errors: [], warnings: [] };
  return compareFacts(extractNumericFacts(claim), extractNumericFacts(supportingQuote), "结论");
}

/** Validates numeric facts in a generated Wiki page against verified claim passages. */
export function validateDraftNumericConsistency(
  content: string,
  claims: EvidenceClaim[]
): NumericFactValidation {
  const supported = claims
    .filter((claim) => claim.relation === "supports")
    .flatMap((claim) => extractNumericFacts(`${claim.claim}\n${claim.supportingQuote}`));
  if (supported.length === 0) return { errors: [], warnings: [] };
  return compareFacts(extractNumericFacts(content), supported, "Wiki 草稿");
}

function compareFacts(actual: NumericFact[], supported: NumericFact[], label: string): NumericFactValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const fact of actual) {
    const compatible = supported.filter((item) => compatibleUnits(fact, item));
    const ranked = compatible
      .map((item) => ({ item, score: contextSimilarity(fact.context, item.context) }))
      .sort((left, right) => right.score - left.score);
    const equivalent = ranked.filter(({ item }) => equivalentFacts(fact, item));
    const distinctSupported = new Set(compatible.map(factIdentity));
    if (equivalent.some(({ score }) => score >= 0.2)
      || (distinctSupported.size === 1 && equivalent.length > 0)) continue;
    const closest = ranked[0];
    if (closest && closest.score >= 0.34) {
      errors.push(`NUMERIC_FACT_MISMATCH：${label}中的“${fact.text}”与证据“${closest.item.text}”不一致`);
    } else if (fact.unit || fact.qualifier !== "exact") {
      warnings.push(`NUMERIC_FACT_UNSUPPORTED：${label}中的“${fact.text}”未找到明确对应的证据数值`);
    }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function factIdentity(fact: NumericFact): string {
  const scaled = SCALES[fact.unit];
  return `${fact.qualifier}:${scaled?.family ?? fact.unit}:${fact.value * (scaled?.scale ?? 1)}`;
}

function equivalentFacts(left: NumericFact, right: NumericFact): boolean {
  if (left.qualifier !== right.qualifier) return false;
  const leftScale = SCALES[left.unit];
  const rightScale = SCALES[right.unit];
  if (leftScale && rightScale && leftScale.family === rightScale.family) {
    return nearlyEqual(left.value * leftScale.scale, right.value * rightScale.scale);
  }
  return left.unit === right.unit && nearlyEqual(left.value, right.value);
}

function compatibleUnits(left: NumericFact, right: NumericFact): boolean {
  if (left.unit === right.unit) return true;
  const leftScale = SCALES[left.unit];
  const rightScale = SCALES[right.unit];
  if (leftScale && rightScale) return leftScale.family === rightScale.family;
  return !left.unit && !right.unit;
}

function qualifierOf(value: string): NumericFact["qualifier"] {
  if (/至少|最少|不低于/u.test(value)) return "min";
  if (/最多|至多|不超过/u.test(value)) return "max";
  if (/超过|大于/u.test(value)) return "greater";
  if (/少于|小于/u.test(value)) return "less";
  if (/约|大约|近/u.test(value)) return "approx";
  return "exact";
}

function factContext(text: string, start: number, end: number): string {
  const separators = ["。", "！", "？", "；", ";", "，", ",", "\n"];
  const clauseStart = Math.max(...separators.map((separator) => text.lastIndexOf(separator, start - 1)), start - 32);
  const endings = separators.map((separator) => text.indexOf(separator, end)).filter((index) => index >= 0);
  const clauseEnd = Math.min(end + 32, ...(endings.length > 0 ? endings : [text.length]));
  return normalizeContext(text.slice(Math.max(0, clauseStart + 1), clauseEnd).replace(NUMBER, ""));
}

function contextSimilarity(left: string, right: string): number {
  const leftParts = ngrams(left);
  const rightParts = ngrams(right);
  if (leftParts.size === 0 || rightParts.size === 0) return left === right && left ? 1 : 0;
  let intersection = 0;
  for (const value of leftParts) if (rightParts.has(value)) intersection += 1;
  return intersection / Math.min(leftParts.size, rightParts.size);
}

function ngrams(value: string): Set<string> {
  const normalized = normalizeContext(value);
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  return new Set(Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2)));
}

function normalizeContext(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
}

function stripNonProse(value: string): string {
  const withoutFrontmatter = value.replace(/^---\n[\s\S]*?\n---\s*/u, "");
  return withoutFrontmatter
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/<!--([\s\S]*?)-->/gu, "")
    .replace(/^#{1,6}\s+.*$/gmu, "")
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/gu, "$1");
}

function isStructuralNumber(text: string, index: number, raw: string): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  if (/^\s*#{1,6}\s*$/u.test(prefix)) return true;
  if (/^\s*$/u.test(prefix) && /^\d+[.)]\s/u.test(text.slice(index))) return true;
  const numeric = raw.match(/\d+(?:\.\d+)?/u)?.[0] ?? "";
  return /^\d{4}-\d{1,2}-\d{1,2}$/u.test(text.slice(index, index + 10))
    || (/^\d{4}$/u.test(numeric) && /年/u.test(raw));
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-9, Math.abs(left) * 1e-9, Math.abs(right) * 1e-9);
}
