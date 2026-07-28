import type { AgentErrorCode } from "../types";

export class AgentExecutionError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "AgentExecutionError";
  }
}
