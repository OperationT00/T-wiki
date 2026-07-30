import assert from "node:assert/strict";
import test from "node:test";

import { normalizePluginSettings } from "../src/agent/agent-settings";
import {
  DouyinVideoConnector,
  isDouyinUrl,
  validateDouyinUrl
} from "../src/connectors/douyin-video-connector";
import {
  resolveYtDlpExecutable,
  sanitizeDiagnostic,
  ytDlpBaseArguments,
  type OnlineVideoMetadata,
  type YtDlpPort,
  type YtDlpRuntimeOptions
} from "../src/connectors/yt-dlp";
import { sourceBodyFromBytes } from "../src/parsing/parser-types";
import type { IntakeProvenance } from "../src/services/intake-service";
import type { SourceManifest } from "../src/types";
import { normalizeSocialVideoTitle } from "../src/core/source-title";

test("Douyin social captions normalize to stable readable titles", () => {
  assert.equal(
    normalizeSocialVideoTitle(
      "我真的听够了AI应用 大模型开发 Java+agent。。。 #Java #Agent #开发 #AI #就业 Java+AI=王炸😡 J...",
      "douyin-video"
    ),
    "我真的听够了 AI 应用 大模型开发 Java + agent"
  );
  assert.equal(normalizeSocialVideoTitle("#Java #AI #开发", "douyin-video"), "Java AI 开发");
  assert.equal(normalizeSocialVideoTitle("😡。。。", "douyin-video"), "douyin-video");
});

test("Douyin routing accepts official single-video HTTPS URLs and rejects lookalikes", () => {
  assert.equal(isDouyinUrl("https://v.douyin.com/Abc_123/"), true);
  assert.equal(isDouyinUrl("https://www.douyin.com/video/7530000000000000000"), true);
  assert.equal(isDouyinUrl("https://www.iesdouyin.com/share/video/7530000000000000000"), true);
  assert.equal(isDouyinUrl("https://www.douyin.com/jingxuan?modal_id=7530000000000000000"), true);
  assert.equal(isDouyinUrl("7530000000000000000"), true);
  assert.equal(validateDouyinUrl("7530000000000000000").toString(), "https://www.douyin.com/video/7530000000000000000");
  assert.equal(
    validateDouyinUrl("https://www.douyin.com/jingxuan?modal_id=7530000000000000000").toString(),
    "https://www.douyin.com/video/7530000000000000000"
  );
  assert.equal(isDouyinUrl("https://www.douyin.com/jingxuan?modal_id=not-a-video"), false);
  assert.equal(isDouyinUrl("https://www.douyin.com/jingxuan?modal_id=7530000000000000000&modal_id=7530000000000000001"), false);
  assert.equal(isDouyinUrl("http://www.douyin.com/video/7530000000000000000"), false);
  assert.equal(isDouyinUrl("https://douyin.example/video/7530000000000000000"), false);
  assert.equal(isDouyinUrl("https://www.douyin.com/live/7530000000000000000"), false);
  assert.throws(() => validateDouyinUrl("https://user:secret@www.douyin.com/video/7530000000000000000"));
});

test("Douyin connector stores a streamed immutable video with traceable metadata", async () => {
  const runtimeOptions: YtDlpRuntimeOptions[] = [];
  const fake = new FakeYtDlp();
  const connector = new DouyinVideoConnector((options) => {
    runtimeOptions.push(options);
    return fake;
  });
  let importedName = "";
  let provenance: IntakeProvenance | undefined;
  let streamed = 0;
  await connector.start({
    async importSource() { throw new Error("streaming import expected"); },
    async importSourceBody(name, source, value) {
      importedName = name;
      provenance = value;
      for await (const chunk of source.openStream()) streamed += chunk.byteLength;
      return { manifest: manifest(), duplicate: false };
    }
  });
  const phases: string[] = [];
  const result = await connector.capture({
    url: "https://v.douyin.com/Abc_123/",
    options: options(false),
    reportProgress: (phase) => phases.push(phase)
  });
  await connector.stop();
  assert.equal(result.metadata.id, "7530000000000000000");
  assert.match(importedName, /课程标题--7530000000000000000\.mp4$/);
  assert.equal(streamed, 16);
  assert.equal(provenance?.acquiredBy, "douyin-video");
  assert.equal(provenance?.deferParse, true);
  assert.equal(provenance?.metadata?.source_platform, "douyin");
  assert.equal(provenance?.metadata?.author, "讲师");
  assert.equal(provenance?.metadata?.author_id, "70387613618");
  assert.equal(provenance?.capture?.videoId, "7530000000000000000");
  assert.deepEqual(phases, ["resolving", "metadata", "downloading", "storing", "complete"]);
  assert.equal(fake.cleaned, true);
  assert.deepEqual(fake.downloadedUrls, ["https://www.douyin.com/video/7530000000000000000"]);
  assert.equal(runtimeOptions[0]?.cookieBrowser, undefined);
  assert.doesNotMatch(JSON.stringify(provenance), /cookie/i);
});

test("Douyin connector preserves the platform caption while importing a canonical title", async () => {
  const originalTitle = "深入理解Java+Agent。。。 #Java #Agent #开发 😡";
  const connector = new DouyinVideoConnector(() => new FakeYtDlp({ title: originalTitle }));
  let provenance: IntakeProvenance | undefined;
  let importedName = "";
  await connector.start({
    async importSource() { throw new Error("streaming import expected"); },
    async importSourceBody(name, _source, value) {
      importedName = name;
      provenance = value;
      return { manifest: manifest(), duplicate: false };
    }
  });
  await connector.capture({
    url: "https://www.douyin.com/video/7530000000000000000",
    options: options(false)
  });
  await connector.stop();
  assert.equal(provenance?.metadata?.title, "深入理解 Java + Agent");
  assert.equal(provenance?.metadata?.source_title_original, originalTitle);
  assert.match(importedName, /^深入理解-Java-\+-Agent--7530000000000000000\.mp4$/);
});

test("Douyin connector only passes browser cookie mode after explicit caller authorization", async () => {
  const seen: YtDlpRuntimeOptions[] = [];
  const connector = new DouyinVideoConnector((runtime) => {
    seen.push(runtime);
    return new FakeYtDlp();
  });
  await connector.start(context());
  await connector.capture({
    url: "https://www.douyin.com/video/7530000000000000000",
    options: options(true)
  });
  assert.equal(seen[0]?.cookieBrowser, "edge");
  await connector.stop();
});

test("Douyin connector rejects a yt-dlp redirect outside official hosts before download", async () => {
  const fake = new FakeYtDlp({ webpageUrl: "https://127.0.0.1/private" });
  const connector = new DouyinVideoConnector(() => fake);
  await connector.start(context());
  await assert.rejects(() => connector.capture({
    url: "https://v.douyin.com/Abc_123/",
    options: options(false)
  }), /抖音官方地址/);
  assert.equal(fake.downloads, 0);
  await connector.stop();
});

test("Douyin connector always cleans temporary media when Intake fails", async () => {
  const fake = new FakeYtDlp();
  const connector = new DouyinVideoConnector(() => fake);
  await connector.start({
    async importSource() { throw new Error("intake failed"); },
    async importSourceBody() { throw new Error("intake failed"); }
  });
  await assert.rejects(() => connector.capture({
    url: "https://v.douyin.com/Abc_123/",
    options: options(false)
  }), /intake failed/);
  assert.equal(fake.cleaned, true);
  await connector.stop();
});

test("yt-dlp security arguments ignore user config and add browser cookies only when requested", () => {
  assert.deepEqual(ytDlpBaseArguments(), ["--ignore-config", "--no-playlist"]);
  assert.deepEqual(ytDlpBaseArguments("firefox"), [
    "--ignore-config", "--no-playlist", "--cookies-from-browser", "firefox"
  ]);
  const diagnostic = sanitizeDiagnostic("C:\\Users\\alice\\x token=abcdefghijklmnopqrstuvwxyz123456789 Cookie: session=private https://x.test?a=1&signature=secret");
  assert.doesNotMatch(diagnostic, /abcdefghijklmnopqrstuvwxyz|signature=secret|session=private/);
});

test("manual yt-dlp configuration rejects ambiguous relative executables", async () => {
  await assert.rejects(() => resolveYtDlpExecutable("yt-dlp"), /必须是绝对路径/);
});

test("stopping the Douyin connector cancels active yt-dlp work", async () => {
  const connector = new DouyinVideoConnector(() => new BlockingYtDlp());
  await connector.start(context());
  const pending = connector.capture({
    url: "https://v.douyin.com/Abc_123/",
    options: options(false)
  });
  await connector.stop();
  await assert.rejects(pending, (error: unknown) => {
    return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "DOUYIN_CANCELLED");
  });
});

test("plugin settings v5 migrate to v6 with safe disabled Douyin defaults", () => {
  const migrated = normalizePluginSettings({ schemaVersion: 5 } as any);
  assert.equal(migrated.schemaVersion, 6);
  assert.deepEqual(migrated.onlineVideo.douyin, {
    enabled: false,
    ytDlpPath: "",
    maxDownloadBytes: 500 * 1024 * 1024,
    taskTimeoutMs: 30 * 60 * 1000,
    cookieBrowser: "edge"
  });
});

class FakeYtDlp implements YtDlpPort {
  cleaned = false;
  downloads = 0;
  downloadedUrls: string[] = [];
  private readonly metadata: OnlineVideoMetadata;

  constructor(overrides: Partial<OnlineVideoMetadata> = {}) {
    this.metadata = {
      id: "7530000000000000000",
      title: "课程标题",
      author: "讲师",
      authorId: "70387613618",
      description: "课程简介",
      durationMs: 120_000,
      webpageUrl: "https://www.douyin.com/video/7530000000000000000",
      isLive: false,
      ...overrides
    };
  }

  async testInstallation() { return { executable: "yt-dlp", version: "test" }; }
  async inspect(_url: string, _signal: AbortSignal) { return this.metadata; }
  async download(url: string, _signal: AbortSignal, report?: (value: any) => void) {
    this.downloads += 1;
    this.downloadedUrls.push(url);
    report?.({ downloadedBytes: 16, totalBytes: 16, percent: 100 });
    const bytes = new Uint8Array(16);
    bytes.set(new TextEncoder().encode("ftypisom"), 4);
    return {
      name: "video.mp4",
      source: sourceBodyFromBytes(bytes),
      size: bytes.byteLength,
      cleanup: async () => { this.cleaned = true; }
    };
  }
}

class BlockingYtDlp extends FakeYtDlp {
  override async inspect(_url: string, signal: AbortSignal): Promise<OnlineVideoMetadata> {
    return new Promise((_, reject) => {
      const abort = (): void => reject(new Error("aborted"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }
}

function options(useBrowserCookies: boolean) {
  return {
    enabled: true,
    ytDlpPath: "yt-dlp",
    maxDownloadBytes: 500 * 1024 * 1024,
    taskTimeoutMs: 60_000,
    cookieBrowser: "edge" as const,
    useBrowserCookies
  };
}

function context() {
  return {
    async importSource() { return { manifest: manifest(), duplicate: false }; },
    async importSourceBody() { return { manifest: manifest(), duplicate: false }; }
  };
}

function manifest(): SourceManifest {
  return {
    schemaVersion: 3,
    manifestRevision: 1,
    sourceId: "source-douyin",
    sourceHash: "a".repeat(64),
    source: { kind: "video", acquiredBy: "douyin-video" },
    original: {
      name: "video.mp4",
      extension: "mp4",
      mime: "video/mp4",
      size: 16,
      objectPath: ".llm-wiki/objects/video.mp4",
      importedAt: "2026-07-30T00:00:00.000Z"
    },
    parse: { status: "queued", revisions: [], attempts: [] },
    ingest: { status: "not_started", attempts: [] }
  };
}
