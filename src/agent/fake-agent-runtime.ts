import { randomUUID } from "node:crypto";
import { setAppTimeout } from "../utils/timers";

import type {
  AgentConfig,
  AgentEvent,
  AgentMessage,
  AgentRuntime,
  AgentSession,
  SessionOptions
} from "../types";

export class FakeAgentRuntime implements AgentRuntime {
  private initialized = false;
  private cancelled = false;

  constructor(
    private readonly chunks: AgentEvent[] = [],
    private readonly delayMs = 0
  ) {}

  async initialize(_config: AgentConfig): Promise<void> {
    this.initialized = true;
  }

  async startSession(_options: SessionOptions): Promise<AgentSession> {
    if (!this.initialized) throw new Error("Fake runtime 尚未初始化");
    this.cancelled = false;
    return { id: randomUUID() };
  }

  async *send(_message: AgentMessage): AsyncIterable<AgentEvent> {
    if (!this.initialized) throw new Error("Fake runtime 尚未初始化");
    for (const chunk of this.chunks) {
      if (this.cancelled) return;
      if (this.delayMs > 0) await new Promise<void>((resolve) => setAppTimeout(resolve, this.delayMs));
      yield chunk;
    }
  }

  async testConnection(): Promise<string> {
    if (!this.initialized) throw new Error("Fake runtime 尚未初始化");
    return "OK";
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  async dispose(): Promise<void> {
    this.cancelled = true;
    this.initialized = false;
  }
}
