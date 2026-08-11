import type { DataAdapter } from "obsidian";
import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";

import { sha256 } from "../core/wiki-core";
import { atomicWriteBinary } from "./source-store";

/**
 * Content-addressed storage for rollback material. Journals and receipts only
 * retain hashes, so identical page versions are stored once across operations.
 */
export class ContentSnapshotStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly internalRoot: string
  ) {}

  async put(content: string): Promise<string> {
    const hash = sha256(content);
    const path = this.path(hash);
    if (!(await this.adapter.exists(path))) {
      try {
        await atomicWriteBinary(this.adapter, path, gzipSync(strToU8(content), { level: 9 }));
      } catch (error) {
        if (!(await this.adapter.exists(path))) throw error;
      }
    }
    if (sha256(await this.readSnapshot(path)) !== hash) {
      throw new Error(`ROLLBACK_SNAPSHOT_CORRUPT:${hash}`);
    }
    return hash;
  }

  async get(hash: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("回滚快照 Hash 无效");
    const path = this.path(hash);
    if (!(await this.adapter.exists(path))) throw new Error(`回滚快照不存在：${hash}`);
    const content = await this.readSnapshot(path);
    if (sha256(content) !== hash) throw new Error(`回滚快照损坏：${hash}`);
    return content;
  }

  path(hash: string): string {
    return `${this.internalRoot}/snapshots/sha256/${hash.slice(0, 2)}/${hash}.md.gz`;
  }

  private async readSnapshot(path: string): Promise<string> {
    return strFromU8(gunzipSync(new Uint8Array(await this.adapter.readBinary(path))));
  }
}
