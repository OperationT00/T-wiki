import Anthropic from "@anthropic-ai/sdk";

import type { AgentConversationMessage, LlmProviderConfig, ModelProfile } from "../../types";
import {
  AgentProviderError,
  classifyProviderError,
  type ConnectionResult,
  type LlmProvider,
  type LlmProviderEvent,
  type LlmRequest,
  normalizeUsage,
  parseToolArguments,
  validateProviderConfig
} from "../llm-provider";

type AnthropicClientFactory = (config: LlmProviderConfig) => any;

export class AnthropicMessagesProvider implements LlmProvider {
  readonly protocol = "anthropic-messages" as const;

  constructor(private readonly createClient: AnthropicClientFactory = defaultClient) {}

  validateConfig(config: LlmProviderConfig): void {
    validateProviderConfig(config);
    if (config.protocol !== this.protocol) {
      throw new AgentProviderError("INVALID_CONFIG", `Provider 协议不匹配：${config.protocol}`, false);
    }
  }

  async *stream(
    config: LlmProviderConfig,
    request: LlmRequest,
    signal: AbortSignal
  ): AsyncIterable<LlmProviderEvent> {
    this.validateConfig(config);
    try {
      const client = this.createClient(config);
      const body: Record<string, unknown> = {
        model: request.model,
        system: request.systemPrompt,
        messages: toAnthropicMessages(
          request.messages ?? [{ role: "user", content: [{ type: "text", text: request.content ?? "" }] }]
        ),
        max_tokens: request.maxOutputTokens,
        stream: true
      };
      if (request.outputSchema) {
        body.output_config = {
          format: { type: "json_schema", schema: request.outputSchema }
        };
      }
      if (request.tools?.length) {
        body.tools = request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
          ...(tool.strict === true ? { strict: true } : {})
        }));
        body.tool_choice = request.toolChoice === "required"
          ? { type: "any" }
          : { type: "auto" };
      }
      const pending = client.messages.create(body, { signal });
      const response = typeof pending.withResponse === "function"
        ? await pending.withResponse()
        : { data: await pending, request_id: undefined };
      const stream = response.data;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let cachedInputTokens: number | undefined;
      let finishReason: string | undefined;
      const toolCalls = new Map<number, { id: string; name: string; json: string; initial?: unknown }>();
      const reasoningBlocks = new Map<number, { text: string; signature?: string }>();
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const text = String(event.delta.text ?? "");
          if (text) yield { type: "text", text };
        } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          toolCalls.set(Number(event.index), {
            id: String(event.content_block.id ?? ""),
            name: String(event.content_block.name ?? ""),
            json: "",
            initial: event.content_block.input
          });
        } else if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
          reasoningBlocks.set(Number(event.index), {
            text: String(event.content_block.thinking ?? ""),
            signature: stringOrUndefined(event.content_block.signature)
          });
        } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
          const block = reasoningBlocks.get(Number(event.index));
          if (block) block.text += String(event.delta.thinking ?? "");
        } else if (event.type === "content_block_delta" && event.delta?.type === "signature_delta") {
          const block = reasoningBlocks.get(Number(event.index));
          if (block) block.signature = `${block.signature ?? ""}${String(event.delta.signature ?? "")}`;
        } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          const call = toolCalls.get(Number(event.index));
          if (call) call.json += String(event.delta.partial_json ?? "");
        } else if (event.type === "content_block_stop") {
          const reasoning = reasoningBlocks.get(Number(event.index));
          if (reasoning) {
            yield {
              type: "reasoning",
              reasoning: {
                type: "reasoning",
                provider: this.protocol,
                text: reasoning.text,
                ...(reasoning.signature ? { signature: reasoning.signature } : {})
              }
            };
            reasoningBlocks.delete(Number(event.index));
          }
        } else if (event.type === "message_start") {
          inputTokens = numberOrUndefined(event.message?.usage?.input_tokens);
          cachedInputTokens = numberOrUndefined(event.message?.usage?.cache_read_input_tokens);
        } else if (event.type === "message_delta") {
          outputTokens = numberOrUndefined(event.usage?.output_tokens);
          if (event.delta?.stop_reason) finishReason = String(event.delta.stop_reason);
        } else if (event.type === "error") {
          throw event.error ?? new Error("Anthropic 流返回错误");
        }
      }
      if (finishReason === "max_tokens") {
        throw new AgentProviderError("OUTPUT_TRUNCATED", "模型输出达到 token 上限，结果已截断", true);
      }
      if (finishReason === "refusal") {
        throw new AgentProviderError("REFUSAL", "模型拒绝生成该响应", false);
      }
      for (const call of [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
        if (!call.id || !call.name) throw new AgentProviderError("UNKNOWN", "模型返回了不完整的 Tool Call", false);
        const input = call.json ? parseToolArguments(call.json, call.name) : (call.initial ?? {});
        yield { type: "tool_call", call: { id: call.id, name: call.name, input } };
      }
      yield {
        type: "result",
        requestId: response.request_id,
        usage: normalizeUsage(inputTokens, outputTokens, cachedInputTokens),
        finishReason
      };
    } catch (error) {
      throw classifyProviderError(error, config.token);
    }
  }

  async testConnection(
    config: LlmProviderConfig,
    model: ModelProfile,
    signal: AbortSignal
  ): Promise<ConnectionResult> {
    let output = "";
    for await (const event of this.stream(config, {
      model: model.id,
      systemPrompt: "Reply with exactly OK.",
      content: "Connection test",
      maxOutputTokens: 16
    }, signal)) {
      if (event.type === "text") output += event.text;
    }
    return { ok: true, message: output.trim() || "OK" };
  }
}

function toAnthropicMessages(messages: AgentConversationMessage[]): any[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((item) => {
      if (item.type === "text") return { type: "text", text: item.text };
      if (item.type === "reasoning") {
        if (item.provider !== "anthropic-messages") return null;
        return {
          type: "thinking",
          thinking: item.text,
          ...(item.signature ? { signature: item.signature } : {})
        };
      }
      if (item.type === "tool_call") {
        return { type: "tool_use", id: item.id, name: item.name, input: item.input ?? {} };
      }
      return {
        type: "tool_result",
        tool_use_id: item.toolCallId,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null),
        is_error: item.isError
      };
    }).filter((item) => item !== null)
  }));
}

function defaultClient(config: LlmProviderConfig): Anthropic {
  return new Anthropic({
    apiKey: config.token,
    baseURL: config.baseUrl.replace(/\/+$/, ""),
    // Obsidian's Electron renderer is browser-like but the plugin is a local,
    // desktop-only Node runtime; credentials remain in Obsidian Secret Storage.
    dangerouslyAllowBrowser: true,
    maxRetries: config.maxRetries,
    timeout: config.timeoutMs
  });
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
