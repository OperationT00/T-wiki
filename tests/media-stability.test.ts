import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChunkedTranscriptionCoordinator, mergeChunkTranscripts } from "../src/parsing/media/chunked-transcription-coordinator";
import type { MediaJobCheckpoint } from "../src/parsing/media/media-job";
import { adaptTranscriptionResponse } from "../src/parsing/media/transcription-response-adapter";
import { sourceBodyFromBytes, type ParseContext } from "../src/parsing/parser-types";
import type { MediaTranscriptionOptions, TranscriptionTransport } from "../src/parsing/media/transcript-types";
import { FileSystemMediaJobStore } from "../src/services/media-job-store";

test("transcription adapter unwraps provider responses and detects millisecond timestamps", () => {
  const result = adaptTranscriptionResponse({
    data: {
      output: {
        duration: 12,
        utterances: [{ start: 1_500, end: 2_750, transcript: "兼容转写", speaker_id: "A" }]
      }
    }
  }, "", {
    provider: "compatible",
    model: "test",
    generated: true,
    timestampUnit: "auto"
  });
  assert.equal(result.segments[0]?.startMs, 1500);
  assert.equal(result.segments[0]?.endMs, 2750);
  assert.equal(result.segments[0]?.speaker, "A");
  assert.equal(result.timePrecision, "segment");
});

test("chunk merge offsets time, removes overlap text, and marks approximate positions", () => {
  const checkpoint: MediaJobCheckpoint = {
    version: 1,
    jobId: "a".repeat(32),
    sourceId: "source",
    sourceHash: "hash",
    parseKey: "key",
    sourcePath: "source.mp4",
    durationMs: 1_798_000,
    chunks: [
      { index: 0, path: "0.mp3", hash: "0", startMs: 0, endMs: 900_000, overlapMs: 0, size: 1, status: "completed", resultPath: "0.json" },
      { index: 1, path: "1.mp3", hash: "1", startMs: 898_000, endMs: 1_798_000, overlapMs: 2_000, size: 1, status: "completed", resultPath: "1.json" }
    ],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    expiresAt: new Date(86_400_000).toISOString()
  };
  const transcript = mergeChunkTranscripts(checkpoint, [
    timed("这里是分片边界的重复文字"),
    timed("分片边界的重复文字，随后进入新内容")
  ]);
  assert.equal(transcript.timePrecision, "chunk");
  assert.equal(transcript.segments[1]?.startMs, 900_000);
  assert.doesNotMatch(transcript.segments[1]?.text ?? "", /^分片边界的重复文字/);
  assert.ok(transcript.issues.some((issue) => issue.code === "TRANSCRIPT_TIMESTAMPS_APPROXIMATE"));
});

test("media job store removes incomplete workspaces by source without deleting originals elsewhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "t-wiki-media-jobs-"));
  try {
    const store = new FileSystemMediaJobStore(root);
    const bytes = new TextEncoder().encode("immutable media source");
    const sourceHash = createHash("sha256").update(bytes).digest("hex");
    const workspace = await store.createWorkspace({
      sourceId: "source-to-delete",
      sourceHash,
      parseKey: "parse-key",
      extension: "mp4",
      retentionHours: 24,
      source: sourceBodyFromBytes(bytes),
      signal: new AbortController().signal
    });
    await store.cleanupSource("source-to-delete");
    await assert.rejects(access(workspace.directory));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chunk coordinator resumes without retranscribing completed chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "t-wiki-media-resume-"));
  try {
    const store = new FileSystemMediaJobStore(root);
    const jobId = "b".repeat(32);
    const directory = join(root, jobId);
    await mkdir(join(directory, "chunks"), { recursive: true });
    const paths = [join(directory, "chunks", "0.mp3"), join(directory, "chunks", "1.mp3")];
    await Promise.all(paths.map((path, index) => writeFile(path, `chunk-${index}`)));
    const checkpoint: MediaJobCheckpoint = {
      version: 1,
      jobId,
      sourceId: "resume-source",
      sourceHash: "source-hash",
      parseKey: "parse-key",
      sourcePath: join(directory, "source.mp4"),
      durationMs: 1_798_000,
      chunks: await Promise.all(paths.map(async (path, index) => {
        const bytes = new TextEncoder().encode(`chunk-${index}`);
        return {
          index,
          path,
          hash: createHash("sha256").update(bytes).digest("hex"),
          startMs: index === 0 ? 0 : 898_000,
          endMs: index === 0 ? 900_000 : 1_798_000,
          overlapMs: index === 0 ? 0 : 2_000,
          size: bytes.byteLength,
          status: "pending" as const
        };
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    };
    const fakePreprocessor = {
      async prepare(_input: unknown, _options: unknown, context: ParseContext) {
        await store.save(checkpoint);
        await context.saveResumeToken(JSON.stringify({ v: 1, jobId, sourceHash: "source-hash", parseKey: "parse-key", nextChunk: 0 }));
        return checkpoint;
      }
    };
    const input = {
      sourceId: "resume-source",
      sourceHash: "source-hash",
      kind: "video" as const,
      name: "video.mp4",
      extension: "mp4",
      mime: "video/mp4",
      source: sourceBodyFromBytes(new TextEncoder().encode("source")),
      size: 6
    };
    const options = transcriptionOptions();
    let token = "";
    const firstCalls: string[] = [];
    const firstTransport = fakeTransport(async (name) => {
      firstCalls.push(name);
      if (name.includes("00001")) throw new Error("network interrupted");
      return timed("第一片已经完成");
    });
    const first = new ChunkedTranscriptionCoordinator(store, fakePreprocessor as never);
    await assert.rejects(first.transcribe(input, firstTransport, options, parseContext((value) => { token = value; })));
    assert.deepEqual(firstCalls, ["chunk-00000.mp3", "chunk-00001.mp3"]);
    assert.equal(JSON.parse(token).nextChunk, 1);

    const resumedCalls: string[] = [];
    const resumed = await new ChunkedTranscriptionCoordinator(store, fakePreprocessor as never).transcribe(
      input,
      fakeTransport(async (name) => { resumedCalls.push(name); return timed("第二片新内容"); }),
      options,
      parseContext((value) => { token = value; }),
      token
    );
    assert.deepEqual(resumedCalls, ["chunk-00001.mp3"]);
    assert.equal(resumed.chunkCount, 2);
    assert.match(resumed.transcript.segments.map((item) => item.text).join(" "), /第一片已经完成.*第二片新内容/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function timed(text: string) {
  return {
    schemaVersion: 1 as const,
    provider: "fake",
    generated: true,
    timePrecision: "none" as const,
    issues: [],
    segments: [{ text }]
  };
}

function transcriptionOptions(): MediaTranscriptionOptions {
  return {
    protocol: "openai-transcriptions",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fake",
    language: "auto",
    vadFilter: true,
    wordTimestamps: false,
    diarization: false,
    maxUploadBytes: 25 * 1024 * 1024,
    taskTimeoutMs: 10_000,
    timestampUnit: "auto",
    preprocessing: {
      enabled: true,
      ffmpegPath: "ffmpeg",
      chunkDurationSeconds: 900,
      overlapSeconds: 2,
      audioBitrateKbps: 64,
      sampleRateHz: 16_000,
      channels: 1,
      resumeRetentionHours: 24
    }
  };
}

function parseContext(save: (token: string) => void): ParseContext {
  return {
    attemptId: "attempt",
    parseKey: "parse-key",
    signal: new AbortController().signal,
    options: {},
    reportProgress() {},
    async saveResumeToken(token) { save(token); }
  };
}

function fakeTransport(run: (name: string) => Promise<ReturnType<typeof timed>>): TranscriptionTransport {
  return {
    protocol: "openai-transcriptions",
    async testConnection() { return { ok: true, message: "ok" }; },
    async transcribe(_source, metadata) { return run(metadata.name); }
  };
}
