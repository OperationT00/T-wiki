import type { EvidenceReference } from "../types";

export type EvidenceId = string;

export class EvidenceLedger {
  private readonly raw = new Set<string>();
  private readonly wiki = new Set<string>();
  private readonly ids = new Map<EvidenceId, EvidenceReference>();
  private readonly keys = new Map<string, EvidenceId>();
  private rawSequence = 0;
  private wikiSequence = 0;

  recordRaw(sourceId: string, contentHash: string, sectionId: string): EvidenceId {
    const key = `${sourceId}\u0000${contentHash}\u0000${sectionId}`;
    this.raw.add(key);
    return this.register(`raw:${key}`, {
      sourceId, contentHash, sectionId
    }, "r", () => ++this.rawSequence);
  }

  recordWiki(path: string, hash: string): EvidenceId {
    const key = `${path}\u0000${hash}`;
    this.wiki.add(key);
    return this.register(`wiki:${key}`, { wikiPath: path, wikiHash: hash }, "w", () => ++this.wikiSequence);
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
