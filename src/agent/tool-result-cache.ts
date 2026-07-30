import { estimateTokens } from "../core/context-budget";
import { sha256 } from "../core/wiki-core";
import type { ToolResult } from "./tools";

interface CacheEntry {
  key: string;
  result: ToolResult;
  tokens: number;
}

export class ToolResultCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalTokens = 0;
  private hitCountValue = 0;

  constructor(private readonly maxEntries = 128, private readonly maxTokens = 250_000) {}

  keyFor(name: string, input: Record<string, unknown>): string | undefined {
    let identity: Record<string, unknown> | undefined;
    if (name === "read_raw_section" && input.sourceId && input.contentHash && input.sectionId) {
      identity = { sourceId: input.sourceId, contentHash: input.contentHash, sectionId: input.sectionId };
    } else if (name === "read_wiki_page" && input.path && input.expectedHash) {
      identity = {
        path: input.path, expectedHash: input.expectedHash, mode: input.mode ?? "outline", sectionId: input.sectionId ?? ""
      };
    } else if (name === "get_page_template" && input.type) {
      identity = { type: input.type, templateVersion: 1 };
    }
    return identity ? `${name}:${canonicalJson(identity)}` : undefined;
  }

  get(key: string): ToolResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hitCountValue += 1;
    return structuredClone(entry.result);
  }

  set(key: string, result: ToolResult): void {
    const tokens = estimateTokens(JSON.stringify(result.output));
    const existing = this.entries.get(key);
    if (existing) {
      this.totalTokens -= existing.tokens;
      this.entries.delete(key);
    }
    this.entries.set(key, { key, result: structuredClone(result), tokens });
    this.totalTokens += tokens;
    this.evict();
  }

  keyHash(key: string): string {
    return sha256(key).slice(0, 16);
  }

  get hits(): number {
    return this.hitCountValue;
  }

  clear(): void {
    this.entries.clear();
    this.totalTokens = 0;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.totalTokens > this.maxTokens) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.totalTokens -= oldest[1].tokens;
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
