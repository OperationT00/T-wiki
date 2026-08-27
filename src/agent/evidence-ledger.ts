import { sha256 } from "../core/wiki-core";
import type { EvidenceClaim, EvidenceReference } from "../types";
import { validateClaimNumericConsistency } from "./fact-consistency";

export type EvidenceId = string;

export class EvidenceLedger {
  private readonly raw = new Set<string>();
  private readonly wiki = new Set<string>();
  private readonly ids = new Map<EvidenceId, EvidenceReference>();
  private readonly keys = new Map<string, EvidenceId>();
  private readonly contents = new Map<EvidenceId, string>();
  private readonly claims = new Map<EvidenceId, EvidenceClaim[]>();
  private rawSequence = 0;
  private wikiSequence = 0;

  recordRaw(sourceId: string, contentHash: string, sectionId: string, content?: string): EvidenceId {
    const key = `${sourceId}\u0000${contentHash}\u0000${sectionId}`;
    this.raw.add(key);
    const id = this.register(`raw:${key}`, {
      sourceId, contentHash, sectionId
    }, "r", () => ++this.rawSequence);
    if (content !== undefined) this.contents.set(id, content);
    return id;
  }

  recordWiki(path: string, hash: string, content?: string): EvidenceId {
    const key = `${path}\u0000${hash}`;
    this.wiki.add(key);
    const id = this.register(`wiki:${key}`, { wikiPath: path, wikiHash: hash }, "w", () => ++this.wikiSequence);
    if (content !== undefined) this.contents.set(id, content);
    return id;
  }

  hasRaw(sourceId: string, contentHash: string, sectionId: string): boolean {
    return this.raw.has(`${sourceId}\u0000${contentHash}\u0000${sectionId}`);
  }

  hasWiki(path: string, hash: string): boolean {
    return this.wiki.has(`${path}\u0000${hash}`);
  }

  rawReferences(): EvidenceReference[] {
    return [...this.raw].map((key) => {
      const [sourceId, contentHash, sectionId] = key.split("\u0000");
      return { sourceId, contentHash, sectionId };
    });
  }

  wikiReferences(): EvidenceReference[] {
    return [...this.wiki].map((key) => {
      const [wikiPath, wikiHash] = key.split("\u0000");
      return { wikiPath, wikiHash };
    });
  }

  resolve(id: EvidenceId): EvidenceReference {
    const value = this.ids.get(id);
    if (!value) throw new Error(`未知 Evidence ID：${id}`);
    return structuredClone(value);
  }

  resolveAll(ids: EvidenceId[], required = false): EvidenceReference[] {
    if (required && ids.length === 0) throw new Error("当前命令要求至少一个 Evidence ID");
    return ids.map((id) => this.resolve(id));
  }

  hasId(id: EvidenceId): boolean {
    return this.ids.has(id);
  }

  entries(): Array<{ id: EvidenceId; reference: EvidenceReference }> {
    return [...this.ids.entries()].map(([id, reference]) => ({ id, reference: structuredClone(reference) }));
  }

  bindClaim(
    id: EvidenceId,
    claim: string,
    supportingQuote: string,
    relation: EvidenceClaim["relation"] = "supports"
  ): EvidenceClaim {
    const reference = this.resolve(id);
    const statement = claim.trim();
    const quote = supportingQuote.trim();
    if (!statement || !quote) throw new Error("证据主张和支持引文不能为空");
    const content = this.contents.get(id);
    if (!content) throw new Error(`Evidence ${id} 没有可验证正文`);
    if (!containsNormalized(content, quote)) throw new Error(`Evidence ${id} 不包含支持引文`);
    const numeric = validateClaimNumericConsistency(statement, quote, relation);
    if (numeric.errors.length > 0) throw new Error(numeric.errors.join("；"));
    const value: EvidenceClaim = {
      claim: statement,
      relation,
      evidence: reference,
      supportingQuote: quote,
      quoteHash: sha256(quote)
    };
    const existing = this.claims.get(id) ?? [];
    if (!existing.some((item) => item.claim === value.claim && item.quoteHash === value.quoteHash)) {
      existing.push(value);
      this.claims.set(id, existing);
    }
    return structuredClone(value);
  }

  bindClaimFromEvidence(id: EvidenceId, claim: string): EvidenceClaim {
    const content = this.contents.get(id);
    if (!content) throw new Error(`Evidence ${id} 没有可验证正文`);
    const quote = content
      .split(/\n+/)
      .map((line) => line.replace(/^\s*(?:#{1,6}|[-*>]|\d+[.)])\s*/, "").trim())
      .find((line) => line.length >= 8)
      ?.slice(0, 320);
    if (!quote) throw new Error(`Evidence ${id} 没有可引用正文`);
    return this.bindClaim(id, claim, quote, "supports");
  }

  claimsFor(ids: EvidenceId[]): EvidenceClaim[] {
    return ids.flatMap((id) => (this.claims.get(id) ?? []).map((claim) => structuredClone(claim)));
  }

  assertKnown(values: EvidenceReference[], required: boolean): void {
    if (required && values.length === 0) throw new Error("当前命令要求每个暂存变更绑定已读取证据");
    for (const value of values) {
      const rawKnown = value.sourceId && value.contentHash && value.sectionId
        && this.hasRaw(value.sourceId, value.contentHash, value.sectionId);
      const wikiKnown = value.wikiPath && value.wikiHash
        && this.hasWiki(value.wikiPath, value.wikiHash);
      if (!rawKnown && !wikiKnown) throw new Error("evidence 未出现在当前 Agent Run 的已读取证据账本中");
    }
  }

  private register(
    key: string,
    reference: EvidenceReference,
    prefix: "r" | "w",
    next: () => number
  ): EvidenceId {
    const existing = this.keys.get(key);
    if (existing) return existing;
    const id = `${prefix}${String(next()).padStart(4, "0")}`;
    this.keys.set(key, id);
    this.ids.set(id, structuredClone(reference));
    return id;
  }
}

function containsNormalized(content: string, quote: string): boolean {
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalize(content).includes(normalize(quote));
}
