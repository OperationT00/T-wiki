import assert from "node:assert/strict";
import test from "node:test";

import {
  InFlightTaskRegistry,
  ResourceScheduler,
  type ScheduledTask
} from "../src/agent/resource-scheduler";

const read = { key: "agent:execution", mode: "read" as const };
const write = { key: "agent:execution", mode: "write" as const };

test("ResourceScheduler bounds concurrent reads", async () => {
  let active = 0;
  let peak = 0;
  const tasks: ScheduledTask<number>[] = Array.from({ length: 6 }, (_, index) => ({
    id: String(index), resources: [read], run: async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return index;
    }
  }));
  const result = await new ResourceScheduler({ maxConcurrency: 3, maxReadConcurrency: 2 }).run(tasks);
  assert.equal(peak, 2);
  assert.deepEqual(result.map((item) => item.value), [0, 1, 2, 3, 4, 5]);
});

test("ResourceScheduler keeps write tasks ordered and prevents read/write overlap", async () => {
  const events: string[] = [];
  const task = (id: string, resources: typeof read | typeof write): ScheduledTask<void> => ({
    id, resources: [resources], run: async () => {
      events.push(`${id}:start`);
      await new Promise((resolve) => setTimeout(resolve, 3));
      events.push(`${id}:end`);
    }
  });
  await new ResourceScheduler({ maxConcurrency: 4 }).run([
    task("read", read), task("write-a", write), task("write-b", write)
  ]);
  assert.deepEqual(events, ["read:start", "read:end", "write-a:start", "write-a:end", "write-b:start", "write-b:end"]);
});

test("ResourceScheduler permits an unrelated page read during another page draft", async () => {
  const events: string[] = [];
  const terminalRead = { key: "agent:terminal", mode: "read" as const };
  const editA: ScheduledTask<void> = {
    id: "edit-a",
    resources: [terminalRead, { key: "working-set", mode: "write" }, { key: "wiki:a", mode: "write" }],
    run: async () => {
      events.push("edit:start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push("edit:end");
    }
  };
  const readB: ScheduledTask<void> = {
    id: "read-b",
    resources: [terminalRead, { key: "wiki:b", mode: "read" }],
    run: async () => { events.push("read:start"); await new Promise((resolve) => setTimeout(resolve, 1)); events.push("read:end"); }
  };
  const readA: ScheduledTask<void> = {
    id: "read-a",
    resources: [terminalRead, { key: "wiki:a", mode: "read" }],
    run: async () => { events.push("same-read:start"); events.push("same-read:end"); }
  };
  await new ResourceScheduler({ maxConcurrency: 3 }).run([editA, readB, readA]);
  assert.equal(events[0], "edit:start");
  assert.equal(events.includes("read:start"), true);
  assert.ok(events.indexOf("edit:end") < events.indexOf("same-read:start"));
});

test("InFlightTaskRegistry shares a pending read and clears it after failure", async () => {
  const registry = new InFlightTaskRegistry();
  let calls = 0;
  const run = () => registry.run("same", async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 3));
    throw new Error("failed");
  });
  await assert.rejects(() => Promise.all([run(), run()]), /failed/);
  assert.equal(calls, 1);
  await assert.rejects(() => run(), /failed/);
  assert.equal(calls, 2);
});

test("ResourceScheduler cancels queued tasks without starting them", async () => {
  const controller = new AbortController();
  let started = 0;
  const tasks: ScheduledTask<number>[] = [0, 1, 2].map((index) => ({
    id: String(index), resources: [read], run: async () => {
      started += 1;
      if (index === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.abort();
      }
      return index;
    }
  }));
  const result = await new ResourceScheduler({ maxConcurrency: 1 }).run(tasks, controller.signal);
  assert.equal(started, 1);
  assert.equal(result[0]?.status, "fulfilled");
  assert.equal(result[1]?.status, "rejected");
  assert.equal(result[2]?.status, "rejected");
});
