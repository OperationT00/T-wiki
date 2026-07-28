import OpenAI from "openai";

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

type OpenAIClientFactory = (config: LlmProviderConfig) => any;

export class OpenAIChatProvider implements LlmProvider {
  readonly protocol = "openai-chat-completions" as const;

  constructor(private readonly createClient: OpenAIClientFactory = defaultClient) {}

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
        messages: [
          { role: "system", content: request.systemPrompt },
          ...toOpenAIMessages(request.messages ?? [{ role: "user", content: [{ type: "text", text: request.content ?? "" }] }])
        ],
        max_tokens: request.maxOutputTokens,
        stream: true,
        stream_options: { include_usage: true }
      };
      if (request.outputSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: "llm_wiki_output",
            strict: true,
            schema: request.outputSchema
          }
        };
      }
      if (request.tools?.length) {
        body.tools = request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            ...(tool.strict === true ? { strict: true } : {})
          }
        }));
        body.tool_choice = request.toolChoice ?? "auto";
        body.parallel_tool_calls = true;
      }
      const pending = client.chat.completions.create(body, { signal });
      const response = typeof pending.withResponse === "function"
        ? await pending.withResponse()
        : { data: await pending, request_id: undefined };
      const stream = response.data;
      let usage: ReturnType<typeof normalizeUsage>;
      let finishReason: string | undefined;
      let refusal = "";
      let reasoning = "";
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        const text = choice?.delta?.content;
        if (typeof text === "string" && text) yield { type: "text", text };
        const reasoningDelta = (choice?.delta as { reasoning_content?: unknown } | undefined)?.reasoning_content;
        if (typeof reasoningDelta === "string") reasoning += reasoningDelta;
        if (typeof choice?.delta?.refusal === "string") refusal += choice.delta.refusal;
        for (const delta of choice?.delta?.tool_calls ?? []) {
          const index = Number(delta.index ?? 0);
          const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
          if (delta.id) current.id = String(delta.id);
          if (delta.function?.name) current.name += String(delta.function.name);
          if (delta.function?.arguments) current.arguments += String(delta.function.arguments);
          toolCalls.set(index, current);
        }
        if (choice?.finish_reason) finishReason = String(choice.finish_reason);
        if (chunk.usage) {
          usage = normalizeUsage(
            numberOrUndefined(chunk.usage.prompt_tokens),
            numberOrUndefined(chunk.usage.completion_tokens),
            numberOrUndefined(chunk.usage.prompt_tokens_details?.cached_tokens)
          );
        }
      }
      if (refusal || finishReason === "content_filter") {
        throw new AgentProviderError("REFUSAL", refusal || "模型拒绝生成该响应", false);
      }
      if (finishReason === "length") {
        throw new AgentProviderError("OUTPUT_TRUNCATED", "模型输出达到 token 上限，结果已截断", true);
      }
      if (reasoning) {
        yield { type: "reasoning", reasoning: { type: "reasoning", provider: this.protocol, text: reasoning } };
      }
      for (const call of [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
        if (!call.id || !call.name) throw new AgentProviderError("UNKNOWN", "模型返回了不完整的 Tool Call", false);
        const input = parseToolArguments(call.arguments, call.name);
        yield { type: "tool_call", call: { id: call.id, name: call.name, input } };
      }
      yield {
        type: "result",
        requestId: response.request_id,
        usage,
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

function toOpenAIMessages(messages: AgentConversationMessage[]): any[] {
  const result: any[] = [];
  for (const message of messages) {
    const texts = message.content.filter((item) => item.type === "text").map((item) => item.text);
    const reasoning = message.content.find(
      (item) => item.type === "reasoning" && item.provider === "openai-chat-completions"
    );
    const calls = message.content.filter((item) => item.type === "tool_call");
    const toolResults = message.content.filter((item) => item.type === "tool_result");
    if (calls.length > 0) {
      result.push({
        role: "assistant",
        content: texts.join("") || null,
        ...(reasoning?.type === "reasoning" ? { reasoning_content: reasoning.text } : {}),
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) }
        }))
      });
    } else if (texts.length > 0) {
      result.push({ role: message.role, content: texts.join("") });
    }
    for (const item of toolResults) {
      result.push({
        role: "tool",
        tool_call_id: item.toolCallId,
        content: stringifyToolOutput(item.output, item.isError)
      });
    }
  }
  return result;
}

function stringifyToolOutput(output: unknown, isError: boolean): string {
  const value = typeof output === "string" ? output : JSON.stringify(output ?? null);
  return isError ? JSON.stringify({ error: value }) : value;
}

function defaultClient(config: LlmProviderConfig): OpenAI {
  return new OpenAI({
    apiKey: config.token.trim() || "local-no-key",
    baseURL: config.baseUrl.replace(/\/+$/, ""),
    // Obsidian plugins run in an Electron renderer with Node integration. The SDK
    // detects `window` and otherwise rejects this trusted local desktop runtime.
    dangerouslyAllowBrowser: true,
    maxRetries: config.maxRetries,
    timeout: config.timeoutMs
  });
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
