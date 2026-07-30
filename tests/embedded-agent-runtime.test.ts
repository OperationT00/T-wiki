import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PLUGIN_SETTINGS, normalizePluginSettings } from "../src/agent/agent-settings";
import { AgentExecutionError } from "../src/agent/agent-errors";
import { EmbeddedAgentRuntime, ProviderRegistry } from "../src/agent/embedded-agent-runtime";
import {
  AgentProviderError,
  classifyProviderError,
  redactSensitive,
  type ConnectionResult,
  type LlmProvider,
  type LlmProviderEvent,
  type LlmRequest,
  validateProviderConfig
} from "../src/agent/llm-provider";
import { AnthropicMessagesProvider } from "../src/agent/providers/anthropic-messages-provider";
import { OpenAIChatProvider } from "../src/agent/providers/openai-chat-provider";
import { compileWireSchema, normalizeStructuredOutput } from "../src/agent/wire-schema";
import type { AgentBudget, AgentConfig, AgentEvent, LlmProviderConfig, ModelProfile } from "../src/types";
import { toPipelineError } from "../src/parsing/pipeline-errors";

const model: ModelProfile = { id: "test-model", label: "Test", contextWindow: 100_000, role: "fast" };

test("OpenAI provider streams text, request id, usage, and native schema", async () => {
  let body: Record<string, any> = {};
  const provider = new OpenAIChatProvider(() => ({
    chat: {
      completions: {
        create(input: Record<string, any>, options: { signal: AbortSignal }) {
          body = input;
          assert.equal(options.signal.aborted, false);
          return response([
            { choices: [{ delta: { content: "{\"ok\":" }, finish_reason: null }] },
            {
              choices: [{ delta: { content: "true}" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } }
            }
          ], "req-openai");
        }
      }
    }
  }));
  const events = await collect(provider.stream(openAiConfig(), request({ type: "object" }), new AbortController().signal));
  assert.equal(events.filter(isText).map((event) => event.text).join(""), "{\"ok\":true}");
  assert.equal(body.response_format.json_schema.strict, true);
  const result = events.find(isResult)!;
  assert.equal(result.requestId, "req-openai");
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 3, totalTokens: 13, cachedInputTokens: 2 });
});

test("Anthropic provider streams text, request id, usage, and native schema", async () => {
  let body: Record<string, any> = {};
  const provider = new AnthropicMessagesProvider(() => ({
    messages: {
      create(input: Record<string, any>) {
        body = input;
        return response([
          { type: "message_start", message: { usage: { input_tokens: 8, cache_read_input_tokens: 3 } } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "{\"ok\":true}" } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }
        ], "req-anthropic");
      }
    }
  }));
  const events = await collect(provider.stream(anthropicConfig(), request({ type: "object" }), new AbortController().signal));
  assert.equal(events.filter(isText).map((event) => event.text).join(""), "{\"ok\":true}");
  assert.deepEqual(body.output_config, { format: { type: "json_schema", schema: { type: "object" } } });
  const result = events.find(isResult)!;
  assert.equal(result.requestId, "req-anthropic");
  assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 4, totalTokens: 12, cachedInputTokens: 3 });
});

test("OpenAI provider aggregates streamed tool arguments and serializes tool results", async () => {
  let body: Record<string, any> = {};
  const provider = new OpenAIChatProvider(() => ({ chat: { completions: {
    create(input: Record<string, any>) {
      body = input;
      return response([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "search_", arguments: '{"query":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "wiki", arguments: '"agent"}' } }] }, finish_reason: "tool_calls" }] }
      ], "req-tool-openai");
    }
  } } }));
  const events = await collect(provider.stream(openAiConfig(), toolRequest(), new AbortController().signal));
  assert.deepEqual(events.find(isToolCall)?.call, { id: "call-1", name: "search_wiki", input: { query: "agent" } });
  assert.equal(body.tool_choice, "required");
  assert.equal(body.tools[0].function.strict, true);
  assert.equal(body.messages.at(-1).role, "tool");
  assert.equal(body.messages.at(-1).tool_call_id, "previous-call");
});

test("Anthropic provider aggregates tool_use JSON and serializes the continuation", async () => {
  let body: Record<string, any> = {};
  const provider = new AnthropicMessagesProvider(() => ({ messages: {
    create(input: Record<string, any>) {
      body = input;
      return response([
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-2", name: "search_wiki", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"agent"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }
      ], "req-tool-anthropic");
    }
  } }));
  const events = await collect(provider.stream(anthropicConfig(), toolRequest(), new AbortController().signal));
  assert.deepEqual(events.find(isToolCall)?.call, { id: "call-2", name: "search_wiki", input: { query: "agent" } });
  assert.deepEqual(body.tool_choice, { type: "any" });
  assert.equal(body.messages.at(-1).content[0].type, "tool_result");
  assert.equal(body.messages.at(-1).content[0].tool_use_id, "previous-call");
});

test("Anthropic provider repairs minor tool JSON only after the stream completes", async () => {
  const provider = new AnthropicMessagesProvider(() => ({ messages: {
    create() {
      return response([
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-repair", name: "search_wiki", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{'query':'agent',}" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } }
      ], "req-repair-anthropic");
    }
  } }));
  const events = await collect(provider.stream(anthropicConfig(), toolRequest(), new AbortController().signal));
  assert.deepEqual(events.find(isToolCall)?.call.input, { query: "agent" });
});

test("Anthropic provider reports truncated tool JSON as OUTPUT_TRUNCATED before parsing it", async () => {
  const provider = new AnthropicMessagesProvider(() => ({ messages: {
    create() {
      return response([
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-cut", name: "search_wiki", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"unfinished' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 32 } }
      ], "req-cut-anthropic");
    }
  } }));
  await assert.rejects(
    collect(provider.stream(anthropicConfig(), toolRequest(), new AbortController().signal)),
    (error: unknown) => (error as AgentProviderError).code === "OUTPUT_TRUNCATED"
  );
});

test("providers preserve DeepSeek reasoning across tool-result continuations", async () => {
  let openAiBody: Record<string, any> = {};
  const openAi = new OpenAIChatProvider(() => ({ chat: { completions: {
    create(input: Record<string, any>) {
      openAiBody = input;
      return response([{ choices: [{ delta: {}, finish_reason: "stop" }] }], "openai-replay");
    }
  } } }));
  const openAiRequest = toolRequest();
  openAiRequest.messages![1]!.content.unshift({
    type: "reasoning", provider: "openai-chat-completions", text: "reason before tool"
  });
  openAiRequest.tools![0]!.strict = false;
  await collect(openAi.stream(openAiConfig(), openAiRequest, new AbortController().signal));
  assert.equal(openAiBody.messages[2].reasoning_content, "reason before tool");
  assert.equal("strict" in openAiBody.tools[0].function, false);

  let anthropicBody: Record<string, any> = {};
  const anthropic = new AnthropicMessagesProvider(() => ({ messages: {
    create(input: Record<string, any>) {
      anthropicBody = input;
      return response([{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }], "anthropic-replay");
    }
  } }));
  const anthropicRequest = toolRequest();
  anthropicRequest.messages![1]!.content.unshift({
    type: "reasoning", provider: "anthropic-messages", text: "reason before tool", signature: "signed"
  });
  anthropicRequest.tools![0]!.strict = false;
  await collect(anthropic.stream(anthropicConfig(), anthropicRequest, new AbortController().signal));
  assert.deepEqual(anthropicBody.messages[1].content[0], {
    type: "thinking", thinking: "reason before tool", signature: "signed"
  });
  assert.equal("strict" in anthropicBody.tools[0], false);
});

test("providers collect streamed DeepSeek reasoning without exposing it as text", async () => {
  const openAi = new OpenAIChatProvider(() => ({ chat: { completions: {
    create() {
      return response([
        { choices: [{ delta: { reasoning_content: "think " } }] },
        { choices: [{ delta: { reasoning_content: "again" }, finish_reason: "tool_calls" }] }
      ], "openai-reasoning");
    }
  } } }));
  const openAiEvents = await collect(openAi.stream(openAiConfig(), request(), new AbortController().signal));
  assert.deepEqual(openAiEvents.find(isReasoning)?.reasoning, {
    type: "reasoning", provider: "openai-chat-completions", text: "think again"
  });
  assert.equal(openAiEvents.filter(isText).length, 0);

  const anthropic = new AnthropicMessagesProvider(() => ({ messages: {
    create() {
      return response([
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "think " } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "again" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }
      ], "anthropic-reasoning");
    }
  } }));
  const anthropicEvents = await collect(anthropic.stream(anthropicConfig(), request(), new AbortController().signal));
  assert.deepEqual(anthropicEvents.find(isReasoning)?.reasoning, {
    type: "reasoning", provider: "anthropic-messages", text: "think again", signature: "signed"
  });
  assert.equal(anthropicEvents.filter(isText).length, 0);
});

test("embedded runtime falls back only for an unsupported schema before output", async () => {
  const provider = new ScriptedProvider([
    new AgentProviderError("UNKNOWN", "response_format json_schema is unsupported", false, 400),
    [{ type: "text", text: "{\"ok\":true}" }, { type: "result", requestId: "fallback" }]
  ]);
  const runtime = runtimeWith(provider, "auto");
  await runtime.startSession({ outputSchema: objectSchema(), maxOutputTokens: 32 });
  const events = await collect(runtime.send({ content: "test" }));
  assert.equal(provider.calls, 2);
  assert.ok(events.some((event) => event.type === "status" && event.message.includes("Prompt JSON")));
  const result = events.find((event): event is Extract<AgentEvent, { type: "result" }> => event.type === "result")!;
  assert.deepEqual(result.structuredOutput, { ok: true });
});

test("embedded runtime never retries schema failure after emitting text", async () => {
  const provider = new PartialFailureProvider();
  const runtime = runtimeWith(provider, "auto");
  await runtime.startSession({ outputSchema: objectSchema() });
  const events = await collect(runtime.send({ content: "test" }));
  assert.equal(provider.calls, 1);
  assert.ok(events.some((event) => event.type === "error"));
});

test("connection test requires a real tool call and a tool-result continuation", async () => {
  const provider = new ScriptedProvider([
    [
      { type: "reasoning", reasoning: { type: "reasoning", provider: "anthropic-messages", text: "connection reasoning" } },
      { type: "tool_call", call: { id: "connection-call", name: "llm_wiki_connection_test", input: { value: "ping" } } },
      { type: "result", requestId: "connection-1" }
    ],
    [{ type: "text", text: "OK" }, { type: "result", requestId: "connection-2" }]
  ]);
  const runtime = runtimeWith(provider, "auto");
  const result = await runtime.testConnection();
  assert.match(result, /Tool Calling/);
  assert.equal(provider.calls, 2);
  assert.equal(provider.requests[0]?.tools?.[0]?.strict, false);
  assert.equal(provider.requests[0]?.maxOutputTokens, 4_096);
  assert.equal(provider.requests[1]?.maxOutputTokens, 4_096);
  assert.deepEqual(provider.requests[1]?.messages?.[1]?.content[0], {
    type: "reasoning", provider: "anthropic-messages", text: "connection reasoning"
  });

  const unsupported = runtimeWith(new ScriptedProvider([
    [{ type: "text", text: "I cannot call tools" }, { type: "result" }]
  ]), "auto");
  await assert.rejects(() => unsupported.testConnection(), /Tool Calling/);
});

test("wire schema is provider-safe and normalizes nullable expectedHash", () => {
  const schema = compileWireSchema({
    type: "object",
    properties: {
      operations: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          required: ["action"],
          properties: {
            action: { type: "string" },
            expectedHash: { type: "string", minLength: 1 }
          }
        }
      }
    }
  });
  const operation = ((schema.properties as any).operations.items);
  assert.equal(operation.additionalProperties, false);
  assert.equal("maxItems" in (schema.properties as any).operations, false);
  assert.deepEqual(operation.required, ["action", "expectedHash"]);
  assert.deepEqual(normalizeStructuredOutput({ operations: [{ action: "create", expectedHash: null }] }), {
    operations: [{ action: "create" }]
  });
});

test("legacy Claude settings migrate to Anthropic API without secret material", () => {
  const migrated = normalizePluginSettings({
    cliPath: "D:/node/claude.cmd",
    baseUrl: "https://api.deepseek.com/anthropic",
    secretId: "legacy-secret-id",
    models: [
      { id: "fast", label: "Fast", contextWindow: 20_000, role: "fast" },
      { id: "default", label: "Default", contextWindow: 30_000, role: "default" },
      { id: "deep", label: "Deep", contextWindow: 40_000, role: "deep" }
    ]
  } as any);
  assert.equal(migrated.schemaVersion, 6);
  assert.equal(migrated.agent.protocol, "anthropic-messages");
  assert.equal(migrated.agent.baseUrl, "https://api.deepseek.com/anthropic");
  assert.equal(migrated.agent.secretId, "legacy-secret-id");
  assert.equal(migrated.agent.models[1]?.id, "default");
  assert.equal("cliPath" in migrated, false);
  assert.equal(JSON.stringify(migrated).includes("D:/node/claude.cmd"), false);
});

test("corrupt v2 settings fall back to safe defaults", () => {
  const normalized = normalizePluginSettings({
    schemaVersion: 2,
    agent: "broken",
    sessions: "broken",
    activeTab: "broken",
    webClipper: "broken"
  } as any);
  assert.equal(normalized.agent.protocol, "anthropic-messages");
  assert.equal(normalized.agent.timeoutMs, 300_000);
  assert.equal(normalized.activeTab, "home");
  assert.deepEqual(normalized.sessions, []);
  assert.equal(normalized.webClipper.inboxPath, "Clippings");
});

test("legacy default budgets migrate to generous run limits without overwriting custom values", () => {
  const migrated = normalizePluginSettings({
    schemaVersion: 4,
    agent: {
      ...DEFAULT_PLUGIN_SETTINGS.agent,
      budgets: {
        ...DEFAULT_PLUGIN_SETTINGS.agent.budgets,
        ingest: {
          ...DEFAULT_PLUGIN_SETTINGS.agent.budgets.ingest,
          maxIterations: 20,
          maxToolCalls: 40,
          maxChangedPages: 12,
          maxWallTimeMs: 600_000,
          maxInputTokens: 120_000,
          maxOutputTokens: 16_384,
          maxToolResultTokens: 12_000
        },
        ingestBatch: {
          ...DEFAULT_PLUGIN_SETTINGS.agent.budgets.ingestBatch,
          maxIterations: 17,
          maxToolCalls: 31,
          maxChangedPages: 9
        }
      }
    }
  } as any);
  assert.deepEqual(
    pickBudget(migrated.agent.budgets.ingest),
    { maxIterations: 120, maxToolCalls: 400, maxChangedPages: 100 }
  );
  assert.deepEqual(
    pickBudget(migrated.agent.budgets.ingestBatch),
    { maxIterations: 17, maxToolCalls: 31, maxChangedPages: 9 }
  );
  assert.equal(migrated.agent.budgets.ingest.maxInputTokens, 4_000_000);
  assert.equal(migrated.agent.budgets.ingest.maxOutputTokens, 256_000);
  assert.equal(migrated.agent.budgets.ingest.maxToolResultTokens, 64_000);
});

test("provider config enforces safe URLs and redacts secrets", () => {
  assert.throws(() => validateProviderConfig({ ...openAiConfig(), baseUrl: "http://192.168.1.8/v1" }), /HTTPS/);
  assert.throws(() => validateProviderConfig({ ...openAiConfig(), baseUrl: "https://user:pass@example.com/v1" }), /凭据/);
  assert.doesNotThrow(() => validateProviderConfig({ ...openAiConfig(), baseUrl: "http://127.0.0.1:11434/v1", token: "" }));
  const redacted = redactSensitive("Authorization: Bearer super-secret https://example.com/v1?token=bad", "super-secret");
  assert.doesNotMatch(redacted, /super-secret|token=bad/);
});

test("runtime cancellation aborts the active provider request", async () => {
  const provider = new BlockingProvider();
  const runtime = runtimeWith(provider, "prompt");
  await runtime.startSession({});
  const pending = collect(runtime.send({ content: "wait" }));
  await provider.started;
  await runtime.cancel();
  const events = await pending;
  const error = events.find((event): event is Extract<AgentEvent, { type: "error" }> => event.type === "error")!;
  assert.equal(error.code, "CANCELLED");
  assert.equal(error.retryable, true);
});

test("provider error classification distinguishes auth, rate limit, and outage", () => {
  assert.equal(classifyProviderError({ status: 401, message: "bad key" }).code, "AUTHENTICATION");
  assert.equal(classifyProviderError({ status: 429, message: "slow down" }).code, "RATE_LIMITED");
  assert.equal(classifyProviderError({ status: 503, message: "down" }).code, "PROVIDER_UNAVAILABLE");
});

test("agent error code and retryability survive ingest pipeline conversion", () => {
  const error = toPipelineError(new AgentExecutionError("RATE_LIMITED", "slow down", true), "ingest");
  assert.equal(error.code, "RATE_LIMITED");
  assert.equal(error.retryable, true);
});

test("schema capability detection accepts common compatible-provider wording", async () => {
  const provider = new ScriptedProvider([
    new AgentProviderError("UNKNOWN", "output_config: Extra inputs are not permitted", false, 422),
    [{ type: "text", text: "{\"ok\":true}" }, { type: "result" }]
  ]);
  const runtime = runtimeWith(provider, "auto");
  await runtime.startSession({ outputSchema: objectSchema() });
  const events = await collect(runtime.send({ content: "test" }));
  assert.equal(provider.calls, 2);
  assert.ok(events.some((event) => event.type === "result"));
});

class ScriptedProvider implements LlmProvider {
  readonly protocol = "anthropic-messages" as const;
  calls = 0;
  readonly requests: LlmRequest[] = [];
  constructor(private readonly scripts: Array<AgentProviderError | LlmProviderEvent[]>) {}
  validateConfig(): void {}
  async *stream(_config: LlmProviderConfig, request: LlmRequest): AsyncIterable<LlmProviderEvent> {
    this.requests.push(structuredClone(request));
    const script = this.scripts[this.calls++]!;
    if (script instanceof AgentProviderError) throw script;
    yield* script;
  }
  async testConnection(): Promise<ConnectionResult> { return { ok: true, message: "OK" }; }
}

class PartialFailureProvider implements LlmProvider {
  readonly protocol = "anthropic-messages" as const;
  calls = 0;
  validateConfig(): void {}
  async *stream(): AsyncIterable<LlmProviderEvent> {
    this.calls += 1;
    yield { type: "text", text: "{" };
    throw new AgentProviderError("UNKNOWN", "output_config is unsupported", false, 400);
  }
  async testConnection(): Promise<ConnectionResult> { return { ok: true, message: "OK" }; }
}

class BlockingProvider implements LlmProvider {
  readonly protocol = "anthropic-messages" as const;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
  validateConfig(): void {}
  async *stream(_config: LlmProviderConfig, _request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmProviderEvent> {
    this.markStarted();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }
  async testConnection(): Promise<ConnectionResult> { return { ok: true, message: "OK" }; }
}

function runtimeWith(provider: LlmProvider, mode: "auto" | "native" | "prompt"): EmbeddedAgentRuntime {
  const runtime = new EmbeddedAgentRuntime(new ProviderRegistry().register(provider));
  void runtime.initialize({
    provider: { ...anthropicConfig(), structuredOutputMode: mode },
    models: [model]
  });
  return runtime;
}

function objectSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: { ok: { type: "boolean" } }
  };
}

function request(outputSchema?: Record<string, unknown>): LlmRequest {
  return { model: model.id, systemPrompt: "system", content: "user", maxOutputTokens: 32, outputSchema };
}

function toolRequest(): LlmRequest {
  return {
    model: model.id,
    systemPrompt: "system",
    messages: [
      { role: "user", content: [{ type: "text", text: "search" }] },
      { role: "assistant", content: [{ type: "tool_call", id: "previous-call", name: "search_wiki", input: { query: "old" } }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "previous-call", output: { matches: [] }, isError: false }] }
    ],
    tools: [{
      name: "search_wiki", description: "search", strict: true,
      inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string" } } }
    }],
    toolChoice: "required",
    maxOutputTokens: 32
  };
}

function openAiConfig(): LlmProviderConfig {
  return {
    protocol: "openai-chat-completions",
    baseUrl: "https://api.example.com/v1",
    token: "test-token",
    structuredOutputMode: "auto",
    timeoutMs: 10_000,
    maxRetries: 2
  };
}

function anthropicConfig(): LlmProviderConfig {
  return { ...openAiConfig(), protocol: "anthropic-messages", baseUrl: "https://api.example.com" };
}

function response(events: unknown[], requestId: string) {
  return {
    withResponse: async () => ({ data: iterable(events), request_id: requestId })
  };
}

async function* iterable(values: unknown[]): AsyncIterable<any> {
  for (const value of values) yield value;
}

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of input) values.push(value);
  return values;
}

function isText(event: LlmProviderEvent): event is Extract<LlmProviderEvent, { type: "text" }> {
  return event.type === "text";
}

function isResult(event: LlmProviderEvent): event is Extract<LlmProviderEvent, { type: "result" }> {
  return event.type === "result";
}

function isToolCall(event: LlmProviderEvent): event is Extract<LlmProviderEvent, { type: "tool_call" }> {
  return event.type === "tool_call";
}

function isReasoning(event: LlmProviderEvent): event is Extract<LlmProviderEvent, { type: "reasoning" }> {
  return event.type === "reasoning";
}

function pickBudget(value: AgentBudget) {
  return {
    maxIterations: value.maxIterations,
    maxToolCalls: value.maxToolCalls,
    maxChangedPages: value.maxChangedPages
  };
}
