import type {
  AgentConversationContent,
  AgentConversationMessage,
  AgentErrorCode,
  AgentToolCall,
  AgentUsage,
  LlmToolDefinition,
  LlmProtocol,
  LlmProviderConfig,
  ModelProfile
} from "../types";
import { jsonrepair } from "jsonrepair";

export interface LlmRequest {
  model: string;
  systemPrompt: string;
  content?: string;
  messages?: AgentConversationMessage[];
  tools?: LlmToolDefinition[];
  toolChoice?: "auto" | "required" | "none";
  maxOutputTokens: number;
  outputSchema?: Record<string, unknown>;
}

export type LlmProviderEvent =
  | { type: "text"; text: string }
  | {
      type: "reasoning";
      reasoning: Extract<AgentConversationContent, { type: "reasoning" }>;
    }
  | { type: "tool_call"; call: AgentToolCall }
  | {
    type: "result";
    requestId?: string;
    usage?: AgentUsage;
    finishReason?: string;
  };

export interface ConnectionResult {
  ok: boolean;
  message: string;
}

export interface LlmProvider {
  readonly protocol: LlmProtocol;
  validateConfig(config: LlmProviderConfig): void;
  stream(
    config: LlmProviderConfig,
    request: LlmRequest,
    signal: AbortSignal
  ): AsyncIterable<LlmProviderEvent>;
  testConnection(
    config: LlmProviderConfig,
    model: ModelProfile,
    signal: AbortSignal
  ): Promise<ConnectionResult>;
}

export class AgentProviderError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AgentProviderError";
  }
}

export function parseToolArguments(text: string, toolName: string): unknown {
  const source = text || "{}";
  try {
    return JSON.parse(source);
  } catch (originalError) {
    try {
      return JSON.parse(jsonrepair(source));
    } catch {
      throw new AgentProviderError(
        "INVALID_STRUCTURED_OUTPUT",
        `Tool ${toolName} 参数不是有效 JSON`,
        false,
        undefined,
        { cause: originalError }
      );
    }
  }
}

export function validateProviderConfig(config: LlmProviderConfig): URL {
  let url: URL;
  try {
    url = new URL(config.baseUrl.trim());
  } catch {
    throw new AgentProviderError("INVALID_CONFIG", "LLM API Base URL 无效", false);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AgentProviderError("INVALID_CONFIG", "LLM API Base URL 只允许 HTTP/HTTPS", false);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AgentProviderError("INVALID_CONFIG", "LLM API Base URL 不能包含凭据、查询参数或片段", false);
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new AgentProviderError("INVALID_CONFIG", "远程 LLM API 必须使用 HTTPS；HTTP 只允许 loopback", false);
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 600_000) {
    throw new AgentProviderError("INVALID_CONFIG", "LLM API 超时必须在 1 秒到 10 分钟之间", false);
  }
  if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 5) {
    throw new AgentProviderError("INVALID_CONFIG", "LLM API 重试次数必须是 0 到 5 的整数", false);
  }
  if (!config.token.trim() && !(config.protocol === "openai-chat-completions" && isLoopback(url.hostname))) {
    throw new AgentProviderError("INVALID_CONFIG", "请先配置 LLM API Token", false);
  }
  return url;
}

export function classifyProviderError(error: unknown, token = ""): AgentProviderError {
  if (error instanceof AgentProviderError) return error;
  const value = error as {
    status?: number;
    code?: string;
    name?: string;
    message?: string;
    error?: { type?: string; message?: string };
  };
  const status = Number(value?.status) || undefined;
  const raw = value?.error?.message ?? value?.message ?? String(error);
  const message = redactSensitive(raw, token);
  const providerCode = `${value?.code ?? ""} ${value?.error?.type ?? ""} ${message}`.toLowerCase();
  if (value?.name === "AbortError" || providerCode.includes("abort")) {
    return new AgentProviderError("CANCELLED", "LLM 请求已取消", true, status, { cause: error });
  }
  if (providerCode.includes("timeout") || status === 408) {
    return new AgentProviderError("TIMEOUT", "LLM API 请求超时", true, status, { cause: error });
  }
  if (status === 401) return new AgentProviderError("AUTHENTICATION", message, false, status, { cause: error });
  if (status === 403) return new AgentProviderError("PERMISSION_DENIED", message, false, status, { cause: error });
  if (status === 429) return new AgentProviderError("RATE_LIMITED", message, true, status, { cause: error });
  if (/context|token.+limit|too.+long/.test(providerCode)) {
    return new AgentProviderError("CONTEXT_LENGTH_EXCEEDED", message, false, status, { cause: error });
  }
  if (status !== undefined && status >= 500) {
    return new AgentProviderError("PROVIDER_UNAVAILABLE", message, true, status, { cause: error });
  }
  return new AgentProviderError("UNKNOWN", message, false, status, { cause: error });
}

export function isSchemaUnsupported(error: unknown): boolean {
  const value = error as { status?: number; message?: string; error?: { message?: string } };
  if (![400, 404, 422].includes(Number(value?.status))) return false;
  const message = `${value?.message ?? ""} ${value?.error?.message ?? ""}`.toLowerCase();
  const rejection = "unsupported|unknown|invalid|not found|not support|unrecognized|extra input|not permitted";
  return new RegExp(`(response_format|json.schema|json_schema|output_config|structured.output).*(${rejection})`).test(message)
    || new RegExp(`(${rejection}).*(response_format|json.schema|json_schema|output_config|structured.output)`).test(message);
}

export function normalizeUsage(input?: number, output?: number, cached?: number): AgentUsage | undefined {
  if (input === undefined && output === undefined && cached === undefined) return undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input !== undefined && output !== undefined ? input + output : undefined,
    cachedInputTokens: cached
  };
}

export function redactSensitive(message: string, token: string): string {
  let value = String(message || "LLM API 请求失败").slice(0, 2_000);
  if (token) value = value.replaceAll(token, "[REDACTED]");
  value = value.replace(/(authorization|api[-_ ]?key|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  value = value.replace(/https?:\/\/[^\s?#]+\?[^\s]*/gi, (url) => url.split("?")[0]!);
  return value;
}

function isLoopback(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}
