export interface ActiveAgentSession {
  purpose: string;
  startedAt: string;
  controller: AbortController;
}

export class AgentSessionManager {
  private active: ActiveAgentSession | null = null;

  begin(purpose: string): ActiveAgentSession {
    if (this.active) throw new Error("已有 Agent Run 正在执行");
    this.active = { purpose, startedAt: new Date().toISOString(), controller: new AbortController() };
    return this.active;
  }

  finish(session: ActiveAgentSession): void {
    if (this.active === session) this.active = null;
  }

  cancel(): void {
    this.active?.controller.abort();
  }

  isActive(): boolean {
    return this.active !== null;
  }

  status(): string {
    return this.active
      ? `${this.active.purpose} · started ${this.active.startedAt}`
      : "当前没有运行中的 Agent";
  }
}
