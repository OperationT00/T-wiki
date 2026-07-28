import assert from "node:assert/strict";
import test from "node:test";

import {
  ParseProgressBus,
  createProgressEvent,
  persistedProgress
} from "../src/parsing/parse-progress";

const identity = {
  sourceId: "source-1",
  sourceName: "document.pdf",
  attemptId: "attempt-1",
  parserId: "pdfjs-layout",
  parserVersion: "1.0.0"
};

test("progress calculator maps exact pages and never moves backwards", () => {
  const first = createProgressEvent(identity, {
    phase: "pdf",
    completed: 5,
    total: 10,
    unit: "page"
  });
  const stale = createProgressEvent(identity, {
    phase: "pdf",
    completed: 2,
    total: 10,
    unit: "page"
  }, first);
  const complete = createProgressEvent(identity, {
    phase: "completed",
    completed: 1,
    total: 1,
    unit: "document"
  }, stale, "completed");

  assert.equal(first.phase, "parsing");
  assert.equal(first.percent, 45);
  assert.equal(first.mode, "determinate");
  assert.equal(first.precision, "exact");
  assert.equal(stale.percent, first.percent);
  assert.equal(complete.percent, 100);
  assert.equal(persistedProgress(complete).percent, 100);
});

test("progress bus isolates listeners and supports unsubscribe", () => {
  const bus = new ParseProgressBus();
  const received: number[] = [];
  bus.subscribe(() => { throw new Error("broken UI listener"); });
  const unsubscribe = bus.subscribe((event) => received.push(event.percent ?? -1));
  const event = createProgressEvent(identity, { phase: "parsing", message: "running" });

  assert.doesNotThrow(() => bus.publish(event));
  unsubscribe();
  bus.publish(createProgressEvent(identity, { phase: "completed" }, event, "completed"));

  assert.deepEqual(received, [10]);
  assert.equal(bus.getLatest(identity.sourceId)?.percent, 100);
});
