import assert from "node:assert/strict";
import test from "node:test";

import { AsyncTaskPool } from "../src/parsing/async-task-pool";

test("parsing task pool bounds concurrency and starts queued work in FIFO order", async () => {
  const pool = new AsyncTaskPool(2);
  const releases: Array<() => void> = [];
  const started: number[] = [];
  let active = 0;
  let peak = 0;

  const tasks = [0, 1, 2, 3].map((id) => pool.run(async () => {
    started.push(id);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases[id] = resolve);
    active -= 1;
    return id;
  }));

  await tick();
  assert.deepEqual(started, [0, 1]);
  assert.equal(peak, 2);
  releases[0]!();
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  releases[1]!();
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3]);
  releases[2]!();
  releases[3]!();
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3]);
  assert.equal(peak, 2);
});

test("parsing task pool cancels queued work without starting it", async () => {
  const pool = new AsyncTaskPool(1);
  let releaseFirst!: () => void;
  const first = pool.run(() => new Promise<void>((resolve) => releaseFirst = resolve));
  const controller = new AbortController();
  let ran = false;
  const queued = pool.run(async () => { ran = true; }, controller.signal);

  controller.abort();
  await assert.rejects(queued, (error: Error) => error.name === "AbortError");
  releaseFirst();
  await first;
  await tick();
  assert.equal(ran, false);
  assert.equal(pool.activeCount, 0);
  assert.equal(pool.queuedCount, 0);
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
