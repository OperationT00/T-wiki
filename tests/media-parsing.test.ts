import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { detectSource } from "../src/parsing/parser-registry";
import { sourceBodyFromBytes, type ParseContext } from "../src/parsing/parser-types";
import {
  paragraphizeUntimedText,
  TranscriptMarkdownBuilder
} from "../src/parsing/media/transcript-markdown-builder";
import { OpenAITranscriptionTransport } from "../src/parsing/media/transcription-transports";
import { BilibiliCaptionParser } from "../src/parsing/parsers/bilibili-caption-parser";
import {
  InMemoryMediaUploadConsent,
  MediaTranscriptionParser
} from "../src/parsing/parsers/media-transcription-parser";
import { isBilibiliUrl } from "../src/connectors/bilibili-video-connector";

const encoder = new TextEncoder();

test("Bilibili routing accepts BV/AV/b23 HTTPS URLs and rejects lookalike hosts", () => {
  assert.equal(isBilibiliUrl("https://www.bilibili.com/video/BV1abc"), true);
  assert.equal(isBilibiliUrl("https://b23.tv/example"), true);
  assert.equal(isBilibiliUrl("https://evil.example/?next=bilibili.com/video/BV1"), false);
  assert.equal(isBilibiliUrl("http://www.bilibili.com/video/av1"), false);
});

test("media magic detection accepts common containers and rejects forged extensions", () => {
  const wav = new Uint8Array(16);
  wav.set(encoder.encode("RIFF"), 0);
  wav.set(encoder.encode("WAVE"), 8);
  assert.deepEqual(detectSource("voice.wav", wav), { extension: "wav", mime: "audio/wav", kind: "audio" });

  const mp4 = new Uint8Array(16);
  mp4.set(encoder.encode("ftypisom"), 4);
  assert.equal(detectSource("video.mp4", mp4).kind, "video");
  assert.throws(() => detectSource("fake.mp3", encoder.encode("not media")), /扩展名与文件内容不匹配/);
});

test("TranscriptMarkdownBuilder aggregates short captions deterministically and links Bilibili time", () => {
  const builder = new TranscriptMarkdownBuilder();
  const transcript = {
    schemaVersion: 1 as const,
    language: "zh-CN",
    durationMs: 10_000,
    provider: "bilibili-caption",
    generated: false,
    issues: [],
    segments: [
      { startMs: 1000, endMs: 2000, text: "第一句。" },
      { startMs: 2100, endMs: 3000, text: "第二句。" },
      { startMs: 7000, endMs: 8000, text: "新段落。" }
    ]
  };
  const first = builder.build(transcript, { title: "测试", bilibiliBvid: "BV1abc", platform: "bilibili" });
  const second = builder.build(transcript, { title: "测试", bilibiliBvid: "BV1abc", platform: "bilibili" });
  assert.equal(first.markdown, second.markdown);
  assert.match(first.markdown, /BV1abc\?t=1/);
  assert.match(first.markdown, /第一句。第二句。/);
  assert.match(first.markdown, /BV1abc\?t=7/);
});

test("untimed provider text becomes stable readable paragraphs without inventing timestamps", () => {
  const sentence = "这是一个用于验证纯文本转写分段的句子，它保留供应商返回的原始措辞。";
  const original = sentence.repeat(24);
  const paragraphs = paragraphizeUntimedText(original);
  assert.equal(paragraphs.length > 1, true);
  assert.equal(paragraphs.every((paragraph) => paragraph.length <= 480), true);
  assert.equal(paragraphs.join(""), original);

  const result = new TranscriptMarkdownBuilder().build({
    schemaVersion: 1,
    provider: "openai-transcriptions",
    generated: true,
    issues: [],
    segments: [{ text: original }]
  }, { title: "完整文字稿" });
  assert.match(result.markdown, /> 转写服务未返回精确时间戳，以下文字已按语句自动分段。/);
  assert.doesNotMatch(result.markdown, /\*\*\[无时间戳\]\*\*/);
  assert.equal(result.markdown.split("\n\n").filter((part) => part.startsWith("这是一个")).length > 1, true);
});

test("Bilibili caption package parses through the regular DocumentParser contract", async () => {
  const value = {
    schemaVersion: 1,
    bvid: "BV1abc123",
    cid: "42",
    page: 1,
    title: "课程",
    partTitle: "第一讲",
    author: "讲师",
    language: "zh-CN",
    trackKind: "author",
    segments: [{ startMs: 3000, endMs: 5000, text: "欢迎学习。" }]
  };
  const bytes = encoder.encode(JSON.stringify(value));
  const parser = new BilibiliCaptionParser();
  const input = {
    sourceId: "source",
    sourceHash: "hash",
    kind: "video" as const,
    name: "course.bili-caption",
    extension: "bili-caption",
    mime: "application/vnd.t-wiki.bilibili-caption+json",
    bytes
  };
  assert.equal((await parser.probe(input)).supported, true);
  const payload = await parser.parse(input, context());
  assert.match(payload.markdown, /欢迎学习/);
  assert.equal(payload.metadata.bilibili_cid, "42");
  assert.equal(payload.metadata.transcript_generated, "false");
});

test("media parser consumes one-shot consent before any remote request", async () => {
  const consent = new InMemoryMediaUploadConsent();
  const parser = new MediaTranscriptionParser({ async getToken() { return ""; } }, consent);
  const bytes = encoder.encode("ID3 fake");
  const input = {
    sourceId: "source-no-consent",
    sourceHash: "hash",
    kind: "audio" as const,
    name: "audio.mp3",
    extension: "mp3",
    mime: "audio/mpeg",
    bytes
  };
  await assert.rejects(
    parser.parse(input, { ...context(), options: mediaOptions("http://127.0.0.1:1") }),
    /明确确认/
  );
});

test("OpenAI-compatible transport sends multipart and preserves returned timestamps", async () => {
  let body = "";
  let authorization = "";
  const server = createServer((request, response) => {
    authorization = String(request.headers.authorization ?? "");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      body = Buffer.concat(chunks).toString("utf8");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        language: "zh",
        duration: 2,
        segments: [{ start: 0.25, end: 1.5, text: "测试转写" }]
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const options = mediaOptions(`http://127.0.0.1:${address.port}`);
    const transport = new OpenAITranscriptionTransport(options, { async getToken() { return "secret-token"; } });
    const source = sourceBodyFromBytes(encoder.encode("ID3 media bytes"));
    const transcript = await transport.transcribe(source, {
      name: "voice.mp3",
      mime: "audio/mpeg",
      size: source.size!
    }, context());
    assert.equal(transcript.segments[0]?.startMs, 250);
    assert.equal(transcript.segments[0]?.endMs, 1500);
    assert.match(body, /name="file"; filename="voice.mp3"/);
    assert.match(body, /name="model"/);
    assert.equal(authorization, "Bearer secret-token");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("media parser preserves online-video metadata in the canonical payload", async () => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        language: "zh",
        duration: 2,
        segments: [{ start: 0, end: 2, text: "抖音课程内容。" }]
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const consent = new InMemoryMediaUploadConsent();
    consent.approve("douyin-source");
    const parser = new MediaTranscriptionParser({ async getToken() { return ""; } }, consent);
    const payload = await parser.parse({
      sourceId: "douyin-source",
      sourceHash: "hash",
      kind: "video",
      name: "downloaded.mp4",
      extension: "mp4",
      mime: "video/mp4",
      bytes: encoder.encode("video media"),
      sourceUri: "https://www.douyin.com/video/7530000000000000000",
      sourceMetadata: {
        title: "抖音课程Java+Agent。。。 #Java #Agent 😡",
        author: "讲师",
        source_platform: "douyin",
        douyin_video_id: "7530000000000000000"
      }
    }, {
      ...context(),
      options: mediaOptions(`http://127.0.0.1:${address.port}`)
    });
    assert.equal(payload.metadata.title, "讲师-抖音课程 Java + Agent");
    assert.equal(payload.metadata.content_title, "抖音课程 Java + Agent");
    assert.equal(payload.metadata.title_generated, "false");
    assert.equal(payload.metadata.source_title_original, "抖音课程Java+Agent。。。 #Java #Agent 😡");
    assert.equal(payload.metadata.author, "讲师");
    assert.equal(payload.metadata.source_platform, "douyin");
    assert.equal(payload.metadata.douyin_video_id, "7530000000000000000");
    assert.match(payload.markdown, /抖音课程内容/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("media parser composes author identity with an LLM-generated content title", async () => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: "Java Agent 的架构设计" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const consent = new InMemoryMediaUploadConsent();
    consent.approve("title-source");
    const parser = new MediaTranscriptionParser(
      { async getToken() { return ""; } },
      consent,
      undefined,
      undefined,
      undefined,
      {
        fingerprint() { return { model: "fast-title" }; },
        async generate() { return { summary: "Java Agent 架构设计", model: "fast-title" }; }
      }
    );
    const payload = await parser.parse({
      sourceId: "title-source",
      sourceHash: "hash",
      kind: "video",
      name: "downloaded.mp4",
      extension: "mp4",
      mime: "video/mp4",
      bytes: encoder.encode("video media"),
      sourceMetadata: {
        title: "原平台标题 #Java",
        author: "讲师名称",
        author_id: "70387613618",
        source_platform: "douyin"
      }
    }, {
      ...context(),
      options: mediaOptions(`http://127.0.0.1:${address.port}`)
    });
    assert.equal(payload.metadata.title, "70387613618-Java Agent 架构设计");
    assert.equal(payload.metadata.content_title, "Java Agent 架构设计");
    assert.equal(payload.metadata.title_generated, "true");
    assert.equal(payload.metadata.title_model, "fast-title");
    assert.match(payload.markdown, /^# 70387613618-Java Agent 架构设计/m);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function context(): ParseContext {
  return {
    signal: new AbortController().signal,
    options: {},
    reportProgress() {},
    async saveResumeToken() {}
  };
}

function mediaOptions(baseUrl: string) {
  return {
    protocol: "openai-transcriptions" as const,
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
