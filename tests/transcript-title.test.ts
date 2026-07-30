import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PLUGIN_SETTINGS } from "../src/agent/agent-settings";
import { AgentTranscriptTitleGenerator } from "../src/agent/transcript-title-generator";
import {
  composeMediaDocumentTitle,
  representativeTranscript,
  sanitizeGeneratedContentTitle
} from "../src/parsing/media/transcript-title";
import type { AgentRuntime } from "../src/types";

test("media title helpers keep author identity deterministic and clean model wording", () => {
  assert.equal(
    composeMediaDocumentTitle("70387613618", "本视频主要介绍了 Java Agent 架构设计。"),
    "70387613618-Java Agent 架构设计"
  );
  assert.equal(sanitizeGeneratedContentTitle("标题：#Java Agent 实战！！！", "fallback"), "Java Agent 实战");
});

test("representative transcript bounds long title prompts while preserving start, middle and end", () => {
  const text = `${"开".repeat(4_000)}${"中".repeat(4_000)}${"尾".repeat(4_000)}`;
  const selected = representativeTranscript({
    schemaVersion: 1,
    provider: "fake",
    generated: true,
    issues: [],
    segments: [{ text }]
  }, 1_000);
  assert.equal(selected.length < 1_100, true);
  assert.match(selected, /\[开头\]/);
  assert.match(selected, /\[中段\]/);
  assert.match(selected, /\[结尾\]/);
  assert.match(selected, /尾/);
});

test("Agent transcript title generator uses the fast model and validates JSON output", async () => {
  let request: Parameters<NonNullable<AgentRuntime["runTurn"]>>[0] | undefined;
  let disposed = false;
  const runtime = {
    async runTurn(input: Parameters<NonNullable<AgentRuntime["runTurn"]>>[0]) {
      request = input;
      return {
        text: "```json\n{\"title\":\"并发容器的锁优化\"}\n```",
        toolCalls: [],
        provider: "openai-chat-completions" as const,
        model: "fast-model"
      };
    },
    async cancel() {},
    async dispose() { disposed = true; }
  } as unknown as AgentRuntime;
  const generator = new AgentTranscriptTitleGenerator(
    { async create() { return runtime; } },
    () => structuredClone(DEFAULT_PLUGIN_SETTINGS)
  );
  const result = await generator.generate({
    originalTitle: "随手发一个视频",
    authorIdentity: "author",
    transcript: {
      schemaVersion: 1,
      provider: "fake",
      generated: true,
      issues: [],
      segments: [{ text: "这里讨论 ConcurrentHashMap 如何减少锁竞争。" }]
    }
  }, new AbortController().signal);
  assert.equal(result.summary, "并发容器的锁优化");
  assert.equal(result.model, "fast-model");
  assert.equal(request?.modelRole, "fast");
  assert.equal(request?.toolChoice, "none");
  assert.equal(disposed, true);
});
