import assert from "node:assert/strict";
import test from "node:test";

import { FakeAgentRuntime } from "../src/agent/fake-agent-runtime";
import type { AgentConfig, AgentEvent } from "../src/types";

const config: AgentConfig = {
  provider: {
    protocol: "anthropic-messages",
    baseUrl: "https://api.example.com",
    token: "test-only",
    structuredOutputMode: "auto",
    timeoutMs: 300_000,
    maxRetries: 2
  },
  models: [{ id: "fake", label: "Fake", contextWindow: 1000, role: "default" }]
};

test("fake runtime streams ordered events", async () => {
  const runtime = new FakeAgentRuntime([
    { type: "status", message: "started" },
    { type: "text", text: "A" },
    { type: "text", text: "B" },
    { type: "result", sessionId: "done", provider: "anthropic-messages", model: "fake" }
  ]);
  await runtime.initialize(config);
  await runtime.startSession({});
  const events: AgentEvent[] = [];
  for await (const event of runtime.send({ content: "hello" })) events.push(event);
  assert.equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "AB");
});

test("fake runtime cancel stops later chunks", async () => {
  const runtime = new FakeAgentRuntime([
    { type: "text", text: "A" },
    { type: "text", text: "B" }
  ]);
  await runtime.initialize(config);
  await runtime.startSession({});
  const output: string[] = [];
  for await (const event of runtime.send({ content: "hello" })) {
    if (event.type === "text") output.push(event.text);
    await runtime.cancel();
  }
  assert.deepEqual(output, ["A"]);
});
