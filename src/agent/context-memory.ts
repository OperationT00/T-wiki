import type { AgentPhase, ContextCheckpoint, EvidenceReference } from "../types";
import type { EvidenceLedger } from "./evidence-ledger";
import type { WorkingSet } from "./working-set";

export interface ContextMemorySnapshot {
  phase: AgentPhase;
  completedTools: string[];
  rawEvidence: EvidenceReference[];
  wikiEvidence: EvidenceReference[];
  stagedPages: Array<{
    path: string;
    action: "create" | "update";
    baseHash?: string;
    characters: number;
    evidenceCount: number;
  }>;
  unresolved: string[];
}

export class ContextMemory {
  private readonly completed = new Set<string>();
  private readonly checkpointValues: ContextCheckpoint[] = [];
  private unresolvedValues: string[] = [];
  private phaseValue: AgentPhase;

  constructor(
    private readonly purpose: "ingest" | "query" | "chat" | "save" | "lint",
    private readonly evidenceLedger: EvidenceLedger,
    private readonly workingSet: WorkingSet,
    private readonly requiredSourceIds: Set<string> = new Set()
  ) {
    this.phaseValue = purpose === "ingest" ? "source_understanding" : "researching";
  }

  recordTool(name: string): { previous: AgentPhase; current: AgentPhase; changed: boolean } {
    const previous = this.phaseValue;
    this.completed.add(name);
    this.phaseValue = this.derivePhase();
    return { previous, current: this.phaseValue, changed: previous !== this.phaseValue };
  }

  refreshPhase(): { previous: AgentPhase; current: AgentPhase; changed: boolean } {
    const previous = this.phaseValue;
    this.phaseValue = this.derivePhase();
    return { previous, current: this.phaseValue, changed: previous !== this.phaseValue };
  }

  addCheckpoint(value: ContextCheckpoint): void {
    this.checkpointValues.push(structuredClone(value));
    this.unresolvedValues = value.unresolved.slice(0, 20);
  }

  get phase(): AgentPhase {
    return this.phaseValue;
  }

  get checkpoints(): ContextCheckpoint[] {
    return structuredClone(this.checkpointValues);
  }

  get completedTools(): Set<string> {
    return new Set(this.completed);
  }

  get ledger(): EvidenceLedger {
    return this.evidenceLedger;
  }

  snapshot(): ContextMemorySnapshot {
    return {
      phase: this.phaseValue,
      completedTools: [...this.completed].sort(),
      rawEvidence: this.evidenceLedger.rawReferences(),
      wikiEvidence: this.evidenceLedger.wikiReferences(),
      stagedPages: this.workingSet.list().map((page) => ({
        path: page.path,
        action: page.action,
        baseHash: page.baseHash,
        characters: page.currentContent.length,
        evidenceCount: page.evidence.length
      })),
      unresolved: [...this.unresolvedValues]
    };
  }

  private derivePhase(): AgentPhase {
    if (this.workingSet.isCurrentRevisionValidated) return "submitting";
    if (this.completed.has("validate_working_set")) return "validating";
    if (this.workingSet.size > 0) return "staging";
    if (this.purpose === "ingest") {
      const readSources = new Set(this.evidenceLedger.rawReferences().map((item) => item.sourceId).filter(Boolean));
      const ready = this.requiredSourceIds.size > 0 && [...this.requiredSourceIds].every((sourceId) => readSources.has(sourceId));
      return ready ? "knowledge_comparison" : "source_understanding";
    }
    if (this.purpose === "query" || this.purpose === "chat") {
      return this.completed.size > 0 ? "answering" : "researching";
    }
    return "researching";
  }
}
