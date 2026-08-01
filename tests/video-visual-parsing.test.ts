import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenAICompatibleVisionProvider, parseAssessments } from "../src/parsing/media/openai-vision-provider";
import { FfmpegFrameExtractor } from "../src/parsing/media/ffmpeg-frame-extractor";
import { TranscriptMarkdownBuilder } from "../src/parsing/media/transcript-markdown-builder";
import { densityLimit, selectFrames, VideoVisualPipeline } from "../src/parsing/media/video-visual-pipeline";
import type {
  FrameSelectionProvider,
  VideoFrameExtractor,
  VideoVisualAnalyzer,
  VideoVisualOptions
} from "../src/parsing/media/video-visual-types";
import { sourceBodyFromBytes, type ParseContext } from "../src/parsing/parser-types";
import {
  InMemoryMediaUploadConsent,
  MediaTranscriptionParser
} from "../src/parsing/parsers/media-transcription-parser";

const encoder = new TextEncoder();

test("video frame density and host selection enforce confidence, gaps, talking heads, and global limits", () => {
  assert.equal(densityLimit(30 * 60_000, 48, 12, 96), 24);
  assert.equal(densityLimit(8 * 60 * 60_000, 48, 12, 96), 96);
  assert.equal(densityLimit(10 * 60_000, 16, 1, 64), 3);
  const candidates = [0, 5_000, 20_000, 40_000].map((timestampMs, index) => ({
    frameId: `f${index}`,
    timestampMs,
    imagePath: "unused",
    thumbnailPath: "unused",
    mime: "image/webp" as const
  }));
  const assessments = [
    assessment("f0", 0.9, "slide"),
    assessment("f1", 0.95, "diagram"),
    assessment("f2", 0.99, "talking_head"),
    assessment("f3", 0.7, "code")
  ];
  const selected = selectFrames(candidates, assessments, {
    confidenceThreshold: 0.75,
    minimumGapMs: 8_000,
    limit: 2
  });
  assert.deepEqual(selected.map((item) => item.candidate.frameId), ["f1"]);
});

test("VideoVisualPipeline uses fake extractor/provider, returns timestamped assets, and cleans temp files", async () => {
  let workingDirectory = "";
  const extractor: VideoFrameExtractor = {
    async fingerprint() { return "ffmpeg fake-1"; },
    async probe() { return { durationMs: 3_600_000, width: 1280, height: 720, ffmpegVersion: "ffmpeg fake-1" }; },
    async extract(_path, options) {
      workingDirectory = options.workingDirectory;
      const imagePath = `${workingDirectory}/frame.webp`;
      const thumbnailPath = `${workingDirectory}/thumb.webp`;
      await writeFile(imagePath, Buffer.from("full-image"));
      await writeFile(thumbnailPath, Buffer.from("thumb-image"));
      return [{ frameId: "frame-t0000010000", timestampMs: 10_000, imagePath, thumbnailPath, mime: "image/webp" }];
    }
  };
  const provider: FrameSelectionProvider = {
    async assess(frames) { return frames.map((frame) => assessment(frame.frameId, 0.92, "diagram")); },
    async testConnection() { return { ok: true, message: "ok" }; }
  };
  const pipeline = new VideoVisualPipeline(extractor, provider, visualOptions());
  const result = await pipeline.analyze(
    sourceBodyFromBytes(encoder.encode("fake video")),
    "lesson.mp4",
    transcript(),
    context()
  );
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0]?.source.startMs, 10_000);
  assert.equal(result.frames[0]?.assetId, "frame-t0000010000");
  await assert.rejects(access(workingDirectory));
});

test("visual batches keep successful frames when another batch fails", async () => {
  const extractor: VideoFrameExtractor = {
    async fingerprint() { return "ffmpeg partial"; },
    async probe() { return { durationMs: 3_600_000, width: 1280, height: 720, ffmpegVersion: "ffmpeg partial" }; },
    async extract(_path, options) {
      const candidates = [];
      for (let index = 0; index < 13; index += 1) {
        const imagePath = join(options.workingDirectory, `frame-${index}.webp`);
        const thumbnailPath = join(options.workingDirectory, `thumb-${index}.webp`);
        await writeFile(imagePath, Buffer.from(`full-${index}`));
        await writeFile(thumbnailPath, Buffer.from(`thumb-${index}`));
        candidates.push({
          frameId: `frame-${index}`,
          timestampMs: index * 10_000,
          imagePath,
          thumbnailPath,
          mime: "image/webp" as const
        });
      }
      return candidates;
    }
  };
  let batches = 0;
  const provider: FrameSelectionProvider = {
    async assess(frames) {
      batches += 1;
      if (batches === 1) throw new Error("temporary vision failure");
      return frames.map((frame) => assessment(frame.frameId, 0.95, "diagram"));
    },
    async testConnection() { return { ok: true, message: "ok" }; }
  };
  const options = visualOptions();
  options.vision.batchSize = 12;
  const result = await new VideoVisualPipeline(extractor, provider, options).analyze(
    sourceBodyFromBytes(encoder.encode("video")),
    "partial.mp4",
    transcript(),
    context()
  );
  assert.equal(batches, 2);
  assert.equal(result.frames.length, 1);
  assert.ok(result.issues.some((issue) => issue.code === "VIDEO_VISUAL_PARTIAL"));
});

test("visual assessment validation rejects unknown IDs and malformed scores", () => {
  assert.throws(() => parseAssessments(JSON.stringify({ assessments: [assessment("invented", 0.9, "slide")] }), new Set(["expected"])), /未知或重复/);
  assert.throws(() => parseAssessments(JSON.stringify({ assessments: [{ ...assessment("expected", 0.9, "slide"), confidence: 2 }] }), new Set(["expected"])), /valuable\/confidence/);
});

test("OpenAI-compatible vision provider sends thumbnails and repairs invalid frame IDs once", async () => {
  let requests = 0;
  let authorization = "";
  let firstBody = "";
  const server = createServer((request, response) => {
    requests += 1;
    authorization = String(request.headers.authorization ?? "");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (requests === 1) firstBody = body;
      const result = requests === 1
        ? { assessments: [assessment("invented", 0.9, "slide")] }
        : { assessments: [assessment("frame-1", 0.9, "slide")] };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const options = visualOptions().vision;
    options.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const provider = new OpenAICompatibleVisionProvider(options, { async getToken() { return "vision-secret"; } });
    const output = await provider.assess([{
      frameId: "frame-1",
      timestampMs: 1000,
      thumbnailBytes: new Uint8Array([1, 2, 3]),
      mime: "image/webp",
      transcriptWindow: "不可信文字上下文"
    }], context());
    assert.equal(requests, 2);
    assert.equal(output[0]?.frameId, "frame-1");
    assert.equal(authorization, "Bearer vision-secret");
    assert.match(firstBody, /data:image\/webp;base64/);
    assert.match(firstBody, /不可信文字上下文/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OpenAI-compatible vision provider preserves the global fetch receiver", async () => {
  const originalFetch = globalThis.fetch;
  let receiver: unknown;
  let requestBody = "";
  globalThis.fetch = async function (this: unknown, _input: RequestInfo | URL, init?: RequestInit) {
    receiver = this;
    requestBody = String(init?.body ?? "");
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        assessments: [assessment("frame-test", 0.9, "slide")]
      }) } }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  } as typeof fetch;
  try {
    const options = visualOptions().vision;
    options.baseUrl = "https://vision.example.com/v1";
    const provider = new OpenAICompatibleVisionProvider(options, {
      async getToken() { return "vision-secret"; }
    });
    const output = await provider.testConnection(new AbortController().signal);
    assert.equal(receiver, globalThis);
    assert.equal(output.ok, true);
    const request = JSON.parse(requestBody) as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url?: string } }> }>;
    };
    const dataUrl = request.messages[1]?.content.find((part) => part.type === "image_url")?.image_url?.url ?? "";
    const png = Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
    assert.equal(png.readUInt32BE(16), 64);
    assert.equal(png.readUInt32BE(20), 64);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TranscriptMarkdownBuilder aligns visual assets to timed text and falls back to a key-frame appendix", () => {
  const builder = new TranscriptMarkdownBuilder();
  const frame = { ...assessment("frame-t0000010000", 0.95, "diagram"), timestampMs: 10_000, assetId: "frame-t0000010000" };
  const timed = builder.build(transcript(), { title: "课程", visualFrames: [frame] });
  assert.match(timed.markdown, /llm-wiki-asset:frame-t0000010000/);
  assert.match(timed.markdown, /> 视频位置：00:00:10/);
  const untimed = builder.build({ ...transcript(), segments: [{ text: "没有时间戳。" }] }, { visualFrames: [frame] });
  assert.match(untimed.markdown, /## 关键画面/);
  assert.ok(untimed.issues.some((issue) => issue.code === "VISUAL_ALIGNMENT_UNAVAILABLE"));
});

test("video visual failure degrades to a text-only payload while audio never invokes the visual pipeline", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ duration: 5, segments: [{ start: 0, end: 5, text: "转写正文。" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let calls = 0;
    const failingFactory = (): VideoVisualAnalyzer => ({
      async fingerprint() { return "fake"; },
      async analyze() { calls += 1; throw new Error("vision offline"); }
    });
    const consent = new InMemoryMediaUploadConsent();
    const parser = new MediaTranscriptionParser(
      { async getToken() { return ""; } },
      consent,
      new TranscriptMarkdownBuilder(),
      { async getToken() { return ""; } },
      failingFactory
    );
    const options = {
      ...transcriptionOptions(`http://127.0.0.1:${address.port}`),
      visual: visualOptions()
    };
    consent.approve("video");
    const video = await parser.parse(mediaInput("video", "video"), { ...context(), options });
    assert.equal(calls, 1);
    assert.equal(video.assets.length, 0);
    assert.ok(video.issues.some((issue) => issue.code === "VIDEO_VISUAL_SKIPPED"));
    consent.approve("audio");
    const audio = await parser.parse(mediaInput("audio", "audio"), { ...context(), options });
    assert.equal(calls, 1);
    assert.ok(!audio.issues.some((issue) => issue.code === "VIDEO_VISUAL_SKIPPED"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("video metadata completes an untimed transcript document and preserves readable paragraphs", async () => {
  const providerText = "这是没有时间戳的供应商转写结果，但宿主仍然需要生成规范段落。".repeat(30);
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ text: providerText }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const factory = (): VideoVisualAnalyzer => ({
      async fingerprint() { return "fake"; },
      async analyze() {
        return {
          metadata: { durationMs: 180_000, width: 1280, height: 720, ffmpegVersion: "fake" },
          frames: [],
          assets: [],
          issues: []
        };
      }
    });
    const consent = new InMemoryMediaUploadConsent();
    const parser = new MediaTranscriptionParser(
      { async getToken() { return ""; } },
      consent,
      new TranscriptMarkdownBuilder(),
      { async getToken() { return ""; } },
      factory
    );
    consent.approve("untimed-video");
    const payload = await parser.parse(mediaInput("untimed-video", "video"), {
      ...context(),
      options: {
        ...transcriptionOptions(`http://127.0.0.1:${address.port}`),
        visual: visualOptions()
      }
    });
    assert.equal(payload.metadata.duration_ms, "180000");
    assert.match(payload.markdown, /以下文字已按语句自动分段/);
    assert.equal(payload.markdown.split("\n\n").filter((part) => part.startsWith("这是没有时间戳")).length > 1, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("optional FFmpeg integration extracts WebP candidates", {
  skip: process.env.T_WIKI_FFMPEG_TEST !== "1"
}, async () => {
  const ffmpeg = process.env.T_WIKI_FFMPEG_PATH || "ffmpeg";
  const directory = await mkdtemp(join(tmpdir(), "t-wiki-ffmpeg-test-"));
  const videoPath = join(directory, "input.mp4");
  try {
    await promisify(execFile)(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=duration=3:size=640x360:rate=10",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath
    ]);
    const bytes = new Uint8Array(await readFile(videoPath));
    const extractor = new FfmpegFrameExtractor(ffmpeg);
    const metadata = await extractor.probe(sourceBodyFromBytes(bytes), new AbortController().signal);
    assert.equal(metadata.width, 640);
    const frames = await extractor.extract(videoPath, {
      workingDirectory: directory,
      sceneThreshold: 0.01,
      maxCandidates: 12,
      maxWidth: 1280,
      imageFormat: "webp",
      imageQuality: 82
    }, context());
    assert.ok(frames.length > 0);
    assert.ok(frames.every((frame) => frame.frameId.startsWith("frame-t") && frame.mime === "image/webp"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function assessment(frameId: string, confidence: number, category: "slide" | "diagram" | "code" | "talking_head") {
  return {
    frameId,
    valuable: true,
    category,
    title: "关键画面",
    description: "客观画面描述",
    reason: "包含结构化信息",
    confidence
  };
}

function transcript() {
  return {
    schemaVersion: 1 as const,
    language: "zh",
    durationMs: 60_000,
    provider: "fake-asr",
    model: "fake",
    generated: true,
    issues: [],
    segments: [
      { startMs: 0, endMs: 20_000, text: "这里展示一个网络架构图。" },
      { startMs: 21_000, endMs: 50_000, text: "随后继续解释图中的连接。" }
    ]
  };
}

function visualOptions(): VideoVisualOptions {
  return {
    enabled: true,
    ffmpegPath: "ffmpeg",
    sceneThreshold: 0.32,
    minFrameGapSeconds: 8,
    candidatesPerHour: 48,
    maxCandidates: 96,
    selectedPerHour: 16,
    maxSelectedFrames: 64,
    maxWidth: 1280,
    imageFormat: "webp",
    imageQuality: 82,
    confidenceThreshold: 0.75,
    maxAssetBytes: 32 * 1024 * 1024,
    vision: {
      protocol: "openai-chat-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "vision-test",
      batchSize: 12,
      timeoutMs: 1000,
      maxRetries: 0,
      captionLanguage: "auto"
    }
  };
}

function transcriptionOptions(baseUrl: string) {
  return {
    protocol: "openai-transcriptions",
    baseUrl,
    model: "whisper-1",
    language: "auto",
    vadFilter: true,
    wordTimestamps: false,
    diarization: false,
    maxUploadBytes: 25 * 1024 * 1024,
    taskTimeoutMs: 10_000
  };
}

function mediaInput(sourceId: string, kind: "audio" | "video") {
  return {
    sourceId,
    sourceHash: "hash",
    kind,
    name: kind === "video" ? "lesson.mp4" : "voice.mp3",
    extension: kind === "video" ? "mp4" : "mp3",
    mime: kind === "video" ? "video/mp4" : "audio/mpeg",
    source: sourceBodyFromBytes(encoder.encode("media")),
    size: 5
  };
}

function context(): ParseContext {
  return {
    signal: new AbortController().signal,
    options: {},
    reportProgress() {},
    async saveResumeToken() {}
  };
}
