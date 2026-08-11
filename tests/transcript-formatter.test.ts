import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PLUGIN_SETTINGS } from "../src/agent/agent-settings";
import { AgentTranscriptFormatter } from "../src/agent/transcript-formatter";
import type { AgentRuntime } from "../src/types";

test("constrained transcript formatter restores punctuation while preserving segment coverage", async () => {
  const runtime = fakeRuntime(JSON.stringify({ paragraphs: [{
    segmentIds: ["s000001", "s000002"],
    text: "客户端发送 SYN 报文，服务端返回 ACK。"
  }] }));
  const formatter = new AgentTranscriptFormatter(
    { async create() { return runtime; } },
    () => structuredClone(DEFAULT_PLUGIN_SETTINGS)
  );
  const result = await formatter.format({
    schemaVersion: 1,
    provider: "fake",
    generated: true,
    timePrecision: "segment",
    issues: [],
    segments: [
      { startMs: 0, endMs: 1_000, text: "客户端发送SYN报文" },
      { startMs: 1_000, endMs: 2_000, text: "服务端返回ACK" }
    ]
  }, new AbortController().signal);
  assert.equal(result.applied, true);
  assert.equal(result.transcript.segments.length, 1);
  assert.equal(result.transcript.segments[0]?.startMs, 0);
  assert.equal(result.transcript.segments[0]?.endMs, 2_000);
  assert.equal(result.transcript.segments[0]?.text, "客户端发送 SYN 报文，服务端返回 ACK。");
});

test("constrained transcript formatter rejects changed numbers and missing segments", async () => {
  const changedNumber = new AgentTranscriptFormatter(
    { async create() { return fakeRuntime(JSON.stringify({ paragraphs: [{
      segmentIds: ["s000001"],
      text: "端口是 8081。"
    }] })); } },
    () => structuredClone(DEFAULT_PLUGIN_SETTINGS)
  );
  await assert.rejects(() => changedNumber.format(transcript("端口是8080"), new AbortController().signal), /字符守恒|数字/);

  const missing = new AgentTranscriptFormatter(
    { async create() { return fakeRuntime(JSON.stringify({ paragraphs: [{
      segmentIds: ["s000001"],
      text: "第一段。"
    }] })); } },
    () => structuredClone(DEFAULT_PLUGIN_SETTINGS)
  );
  await assert.rejects(() => missing.format({
    ...transcript("第一段"),
    segments: [{ text: "第一段" }, { text: "第二段" }]
  }, new AbortController().signal), /遗漏、重复或调换/);
});

function transcript(text: string) {
  return {
    schemaVersion: 1 as const,
    provider: "fake",
    generated: true,
    issues: [],
    segments: [{ text }]
  };
}

function fakeRuntime(text: string): AgentRuntime {
  return {
    async runTurn() {
      return {
        text,
        toolCalls: [],
        provider: "openai-chat-completions" as const,
        model: "fast-model"
      };
    },
    async cancel() {},
    async dispose() {}
  } as unknown as AgentRuntime;
}
