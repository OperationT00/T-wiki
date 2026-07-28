import { randomUUID } from "node:crypto";

import { extractJsonObject } from "../core/wiki-core";
import type {
  AgentConfig,
  AgentEvent,
  AgentMessage,
  AgentRuntime,
  AgentSession,
  AgentTurnRequest,
  AgentTurnResult,
  ModelProfile,
  SessionOptions,
  StructuredOutputMode
} from "../types";
import {
  AgentProviderError,
  classifyProviderError,
  isSchemaUnsupported,
  type LlmProvider,
  type LlmRequest
} from "./llm-provider";
import { compileWireSchema, normalizeStructuredOutput } from "./wire-schema";

interface RuntimeSession extends AgentSession {
  options: SessionOptions;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, LlmProvider>();

  register(provider: LlmProvider): this {
    if (this.providers.has(provider.protocol)) throw new Error(`重复的 LLM Provider：${provider.protocol}`);
    this.providers.set(provider.protocol, provider);
    return this;
  }

  get(protocol: string): LlmProvider {
    const provider = this.providers.get(protocol);
    if (!provider) throw new AgentProviderError("INVALID_CONFIG", `未注册 LLM Provider：${protocol}`, false);
    return provider;
  }
}

export class EmbeddedAgentRuntime implements AgentRuntime {
  private config: AgentConfig | null = null;
  private session: RuntimeSession | null = null;
  private controller: AbortController | null = null;
  private lastStructuredMode: "none" | "native" | "prompt" = "none";

  constructor(private readonly providers: ProviderRegistry) {}

  async initialize(config: AgentConfig): Promise<void> {
    if (config.models.length === 0 || config.models.some((model) => !model.id.trim())) {
      throw new AgentProviderError("INVALID_CONFIG", "至少配置一个有效的模型 ID", false);
    }
    this.providers.get(config.provider.protocol).validateConfig(config.provider);
    this.config = structuredClone(config);
  }

  async startSession(options: SessionOptions): Promise<AgentSession> {
    if (!this.config) throw new AgentProviderError("INVALID_CONFIG", "Embedded Agent Runtime 尚未初始化", false);
    this.session = { id: randomUUID(), options: structuredClone(options) };
    return this.session;
  }

  async *send(message: AgentMessage): AsyncIterable<AgentEvent> {
    if (!this.config) throw new AgentProviderError("INVALID_CONFIG", "Embedded Agent Runtime 尚未初始化", false);
    if (!this.session) await this.startSession({});
    await this.cancel();
    this.controller = new AbortController();
    const config = this.config;
    const session = this.session!;
    const model = selectModel(config.models, session.options.modelRole ?? "default");
    const provider = this.providers.get(config.provider.protocol);
    const schema = session.options.outputSchema ? compileWireSchema(session.options.outputSchema) : undefined;
    const requestedMode = schema ? config.provider.structuredOutputMode : "prompt";
    let emitted = false;

    try {
      yield { type: "status", message: `正在连接 ${provider.protocol} · ${model.label}…` };
      const modes: Array<"native" | "prompt"> = schema && requestedMode !== "prompt"
        ? requestedMode === "auto" ? ["native", "prompt"] : ["native"]
        : ["prompt"];

      for (let index = 0; index < modes.length; index += 1) {
        const mode = modes[index]!;
        let output = "";
        let resultEvent: Extract<AgentEvent, { type: "result" }> | undefined;
        try {
          const request = buildRequest(message.content, session.options, model, mode, schema);
          for await (const event of provider.stream(config.provider, request, this.controller.signal)) {
            if (event.type === "text") {
              emitted = true;
              output += event.text;
              yield event;
            } else if (event.type === "result") {
              resultEvent = {
                type: "result",
                sessionId: session.id,
                provider: provider.protocol,
                model: model.id,
                requestId: event.requestId,
                usage: event.usage
              };
            }
          }
          if (!output.trim()) {
            throw new AgentProviderError("INVALID_STRUCTURED_OUTPUT", "LLM API 返回了空响应", true);
          }
          this.lastStructuredMode = schema ? mode : "none";
          if (schema) {
            try {
              resultEvent = {
                ...resultEvent!,
                structuredOutput: normalizeStructuredOutput(
                  mode === "native" ? JSON.parse(output) : extractJsonObject(output)
                )
              };
            } catch (error) {
              throw new AgentProviderError(
                "INVALID_STRUCTURED_OUTPUT",
                "LLM API 返回的结构化结果不是有效 JSON",
                false,
                undefined,
                { cause: error }
              );
            }
          }
          yield resultEvent ?? {
            type: "result",
            sessionId: session.id,
            provider: provider.protocol,
            model: model.id
          };
          return;
        } catch (error) {
          const canFallback = mode === "native"
            && requestedMode === "auto"
            && !emitted
            && isSchemaUnsupported(error)
            && index + 1 < modes.length;
          if (!canFallback) throw error;
          yield { type: "status", message: "服务不支持原生 JSON Schema，已切换 Prompt JSON 兼容模式…" };
        }
      }
    } catch (error) {
      const failure = classifyProviderError(error, config.provider.token);
      yield { type: "error", code: failure.code, error: failure.message, retryable: failure.retryable };
    } finally {
      this.controller = null;
    }
  }

  async runTurn(request: AgentTurnRequest, sink: (event: AgentEvent) => void = () => undefined): Promise<AgentTurnResult> {
    if (!this.config) throw new AgentProviderError("INVALID_CONFIG", "Embedded Agent Runtime 尚未初始化", false);
    await this.cancel();
    this.controller = new AbortController();
    const config = this.config;
    const model = selectModel(config.models, request.modelRole ?? "default");
    const provider = this.providers.get(config.provider.protocol);
    let text = "";
    const reasoning: NonNullable<AgentTurnResult["reasoning"]> = [];
    const toolCalls: AgentTurnResult["toolCalls"] = [];
    let requestId: string | undefined;
    let usage: AgentTurnResult["usage"];
    let finishReason: string | undefined;
    try {
      for await (const event of provider.stream(config.provider, {
        model: model.id,
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        tools: request.tools,
        toolChoice: request.toolChoice,
        maxOutputTokens: request.maxOutputTokens
      }, this.controller.signal)) {
        if (event.type === "text") {
          text += event.text;
          sink(event);
        } else if (event.type === "reasoning") {
          reasoning.push(event.reasoning);
        } else if (event.type === "tool_call") {
          toolCalls.push(event.call);
        } else {
          requestId = event.requestId;
          usage = event.usage;
          finishReason = event.finishReason;
        }
      }
      return {
        text,
        reasoning,
        toolCalls,
        provider: provider.protocol,
        model: model.id,
        requestId,
        usage,
        finishReason
      };
    } catch (error) {
      const failure = classifyProviderError(error, config.provider.token);
      sink({ type: "error", code: failure.code, error: failure.message, retryable: failure.retryable });
      throw failure;
    } finally {
      this.controller = null;
    }
  }

  async testConnection(): Promise<string> {
    if (!this.config) throw new AgentProviderError("INVALID_CONFIG", "Embedded Agent Runtime 尚未初始化", false);
    const tool = {
      name: "llm_wiki_connection_test",
      description: "Call this tool to prove native tool calling works.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } }
      },
      strict: false
    };
    const first = await this.runTurn({
      modelRole: "fast",
      systemPrompt: "You must call the provided connection test tool.",
      messages: [{ role: "user", content: [{ type: "text", text: "Call the connection test tool with value ping." }] }],
      tools: [tool],
      toolChoice: "required",
      // Reasoning-first models such as DeepSeek V4 count hidden thinking against
      // max_tokens before they emit the Tool Call. A tiny smoke-test allowance
      // therefore produces a false negative even though Tool Calling works.
      maxOutputTokens: 4_096
    });
    const call = first.toolCalls.find((item) => item.name === tool.name);
    if (!call) throw new AgentProviderError("INVALID_CONFIG", "当前模型或兼容服务不支持原生 Tool Calling", false);
    if (!isConnectionTestInput(call.input)) {
      throw new AgentProviderError("INVALID_CONFIG", "模型返回了无效的连接测试 Tool Call 参数", false);
    }
    const second = await this.runTurn({
      modelRole: "fast",
      systemPrompt: "Acknowledge the successful tool result with OK.",
      messages: [
        { role: "user", content: [{ type: "text", text: "Call the connection test tool with value ping." }] },
        {
          role: "assistant",
          content: [
            ...(first.reasoning ?? []),
            { type: "tool_call", id: call.id, name: call.name, input: call.input }
          ]
        },
        { role: "user", content: [{ type: "tool_result", toolCallId: call.id, output: { ok: true }, isError: false }] }
      ],
      tools: [tool],
      toolChoice: "auto",
      maxOutputTokens: 4_096
    });
    if (!second.text.trim()) throw new AgentProviderError("INVALID_CONFIG", "Tool Result 续轮未返回文本", false);
    const model = selectModel(this.config.models, "fast");
    return `${this.config.provider.protocol} · ${model.id} · 原生 Tool Calling`;
  }

  async cancel(): Promise<void> {
    this.controller?.abort();
    this.controller = null;
  }

  async dispose(): Promise<void> {
    await this.cancel();
    this.session = null;
    this.config = null;
  }
}

function isConnectionTestInput(input: unknown): input is { value: "ping" } {
  return Boolean(input && typeof input === "object" && (input as { value?: unknown }).value === "ping");
}

function buildRequest(
  content: string,
  options: SessionOptions,
  model: ModelProfile,
  mode: "native" | "prompt",
  schema?: Record<string, unknown>
): LlmRequest {
  let systemPrompt = options.systemPrompt ?? "You are a concise LLM Wiki assistant.";
  if (schema && mode === "prompt") {
    systemPrompt += `\n必须只返回一个符合以下 JSON Schema 的 JSON 对象，不要使用 Markdown 代码围栏：\n${JSON.stringify(schema)}`;
  }
  return {
    model: model.id,
    systemPrompt,
    content,
    maxOutputTokens: options.maxOutputTokens ?? 4096,
    outputSchema: mode === "native" ? schema : undefined
  };
}

function selectModel(models: ModelProfile[], role: ModelProfile["role"]): ModelProfile {
  return models.find((model) => model.role === role)
    ?? models.find((model) => model.role === "default")
    ?? models[0]!;
}
