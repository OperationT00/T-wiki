import type { DataAdapter } from "obsidian";

import type { IngestInput, WikiChangePlan } from "../types";
import { atomicReplaceText } from "./source-store";

export interface StoredPendingAttempt {
  sourceId: string;
  attemptId: string;
  input: IngestInput;
}

export interface StoredPendingPlan {
  version: 1;
  savedAt: string;
  plan: WikiChangePlan;
  attempts: StoredPendingAttempt[];
}

export class PendingPlanStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly path: string
  ) {}

  async save(plan: WikiChangePlan, attempts: StoredPendingAttempt[]): Promise<void> {
    const value: StoredPendingPlan = {
      version: 1,
      savedAt: new Date().toISOString(),
      plan: structuredClone(plan),
      attempts: structuredClone(attempts)
    };
    await atomicReplaceText(this.adapter, this.path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async load(): Promise<StoredPendingPlan | null> {
    if (!(await this.adapter.exists(this.path))) return null;
    const value = JSON.parse(await this.adapter.read(this.path)) as Partial<StoredPendingPlan>;
    if (value.version !== 1 || !value.plan || !Array.isArray(value.attempts)) {
      throw new Error("待审核计划存储损坏");
    }
    return value as StoredPendingPlan;
  }

  async clear(): Promise<void> {
    if (await this.adapter.exists(this.path)) await this.adapter.remove(this.path);
  }
}
