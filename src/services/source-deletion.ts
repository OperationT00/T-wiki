import { sha256 } from "../core/wiki-core";
import type { RollbackReceipt } from "../types";

export function validateSourceDeletionChain(
  receipts: RollbackReceipt[],
  currentContents: ReadonlyMap<string, string | undefined>
): Array<{ path?: string; reason: string }> {
  const conflicts: Array<{ path?: string; reason: string }> = [];
  const simulated = new Map(currentContents);
  for (const receipt of receipts) {
    for (const change of receipt.changes) {
      const current = simulated.get(change.path);
      if (current === undefined) {
        conflicts.push({ path: change.path, reason: "Wiki 页面已经不存在" });
        continue;
      }
      if (sha256(current) !== change.afterHash) {
        conflicts.push({ path: change.path, reason: "Wiki 页面已被后续操作修改" });
        continue;
      }
      simulated.set(change.path, change.before === null ? undefined : change.before);
    }
  }
  return conflicts;
}
