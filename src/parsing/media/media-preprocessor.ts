import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import type { MediaJobCheckpoint, MediaJobStorePort } from "./media-job";
import type { MediaPreprocessingOptions } from "./transcript-types";
import { ParserError, parseInputSource, throwIfAborted, type ParseContext, type ParseInput } from "../parser-types";

export class MediaPreprocessor {
  constructor(private readonly jobs: MediaJobStorePort) {}

  async prepare(input: ParseInput, options: MediaPreprocessingOptions, context: ParseContext): Promise<MediaJobCheckpoint> {
    if (!this.jobs.available) throw new ParserError("MEDIA_PREPROCESSOR_REQUIRED", "当前存储环境不支持媒体预处理");
    context.reportProgress({ phase: "reading-media-info", mode: "indeterminate", message: "正在读取媒体信息" });
    const workspace = await this.jobs.createWorkspace({
      sourceId: input.sourceId,
      sourceHash: input.sourceHash,
      parseKey: context.parseKey ?? input.sourceHash,
      extension: input.extension,
      retentionHours: options.resumeRetentionHours,
      source: parseInputSource(input),
      signal: context.signal
    });
    const durationMs = await this.probeDuration(workspace.sourcePath, options.ffmpegPath, context.signal);
    const chunkDirectory = join(workspace.directory, "chunks");
    await mkdir(chunkDirectory, { recursive: true });
    const durationSeconds = Math.max(1, Math.ceil(durationMs / 1000));
    const chunkCount = Math.ceil(durationSeconds / options.chunkDurationSeconds);
    const chunks: MediaJobCheckpoint["chunks"] = [];
    context.reportProgress({ phase: "extracting-audio", completed: 0, total: durationSeconds, unit: "second", message: "正在提取并规范化音频" });
    for (let index = 0; index < chunkCount; index += 1) {
      throwIfAborted(context.signal);
      const logicalStart = index * options.chunkDurationSeconds;
      const actualStart = Math.max(0, logicalStart - (index > 0 ? options.overlapSeconds : 0));
      const logicalEnd = Math.min(durationSeconds, (index + 1) * options.chunkDurationSeconds);
      const actualDuration = Math.max(0.1, logicalEnd - actualStart);
      const chunkPath = join(chunkDirectory, `chunk-${String(index).padStart(5, "0")}.mp3`);
      await run(options.ffmpegPath, [
        "-hide_banner", "-nostdin", "-y",
        "-ss", String(actualStart), "-i", workspace.sourcePath,
        "-t", String(actualDuration), "-vn",
        "-ac", String(options.channels), "-ar", String(options.sampleRateHz),
        "-c:a", "libmp3lame", "-b:a", `${options.audioBitrateKbps}k`,
        chunkPath
      ], context.signal, false, (processedSeconds) => {
        context.reportProgress({
          phase: "extracting-audio",
          completed: Math.min(durationSeconds, actualStart + processedSeconds),
          total: durationSeconds,
          unit: "second",
          message: `正在生成音频分片 ${index + 1}/${chunkCount}`
        });
      });
      const info = await stat(chunkPath);
      if (info.size <= 0) throw new ParserError("MEDIA_PREPROCESSING_FAILED", `音频分片 ${index + 1} 为空`);
      chunks.push({
        index,
        path: chunkPath,
        hash: await hashFile(chunkPath),
        startMs: actualStart * 1000,
        endMs: logicalEnd * 1000,
        overlapMs: Math.max(0, logicalStart - actualStart) * 1000,
        size: info.size,
        status: "pending"
      });
      context.reportProgress({
        phase: "extracting-audio",
        completed: logicalEnd,
        total: durationSeconds,
        unit: "second",
        message: `已生成音频分片 ${index + 1}/${chunkCount}`
      });
    }
    const checkpoint: MediaJobCheckpoint = {
      version: 1,
      jobId: workspace.jobId,
      sourceId: input.sourceId,
      sourceHash: input.sourceHash,
      parseKey: context.parseKey ?? input.sourceHash,
      sourcePath: workspace.sourcePath,
      durationMs,
      chunks,
      createdAt: workspace.createdAt,
      updatedAt: workspace.createdAt,
      expiresAt: workspace.expiresAt
    };
    await this.jobs.save(checkpoint);
    await context.saveResumeToken(JSON.stringify(resumeToken(checkpoint)));
    return checkpoint;
  }

  async fingerprint(options: MediaPreprocessingOptions, signal: AbortSignal): Promise<string> {
    const result = await run(options.ffmpegPath, ["-version"], signal);
    return result.stdout.split(/\r?\n/, 1)[0]?.trim() ?? "ffmpeg";
  }

  private async probeDuration(sourcePath: string, configuredPath: string, signal: AbortSignal): Promise<number> {
    const result = await run(ffprobePath(configuredPath), [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", sourcePath
    ], signal, true);
    const duration = Number(result.stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new ParserError("MEDIA_DURATION_INVALID", "FFprobe 未返回有效媒体时长");
    return Math.round(duration * 1000);
  }
}

export function resumeToken(checkpoint: MediaJobCheckpoint) {
  return {
    v: 1 as const,
    jobId: checkpoint.jobId,
    sourceHash: checkpoint.sourceHash,
    parseKey: checkpoint.parseKey,
    nextChunk: checkpoint.chunks.find((item) => item.status === "pending")?.index ?? checkpoint.chunks.length
  };
}

export function parseMediaResumeToken(value: string) {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(value) as Record<string, unknown>; }
  catch { throw new ParserError("TRANSCRIPTION_RESUME_INVALID", "媒体断点 Token 不是有效 JSON"); }
  if (parsed.v !== 1 || typeof parsed.jobId !== "string" || typeof parsed.sourceHash !== "string"
    || typeof parsed.parseKey !== "string" || typeof parsed.nextChunk !== "number") {
    throw new ParserError("TRANSCRIPTION_RESUME_INVALID", "媒体断点 Token 格式无效");
  }
  return parsed as unknown as import("./media-job").MediaResumeToken;
}

function ffmpegPath(configured: string): string {
  const value = configured.trim();
  if (!value) return "ffmpeg";
  if (/^ffmpeg(?:\.exe)?$/i.test(basename(value))) return value;
  if (isAbsolute(value) && !extname(value)) return join(value, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  throw new ParserError("FFMPEG_PATH_INVALID", "FFmpeg 路径必须是可执行文件或其所在目录");
}

function ffprobePath(configured: string): string {
  const executable = ffmpegPath(configured);
  if (!isAbsolute(executable) && dirname(executable) === ".") return process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  return resolve(dirname(executable), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
}

async function run(
  configured: string,
  args: string[],
  signal: AbortSignal,
  isProbe = false,
  onTime?: (seconds: number) => void
): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(signal);
  const executable = isProbe ? configured : ffmpegPath(configured);
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    try { child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) {
      reject(new ParserError("FFMPEG_NOT_AVAILABLE", error instanceof Error ? error.message : String(error)));
      return;
    }
    const abort = (): void => {
      child.kill();
      if (!settled) reject(new ParserError("PARSE_CANCELLED", "媒体预处理已取消", true));
      settled = true;
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk.toString("utf8")); });
    child.stderr.on("data", (chunk: Buffer) => {
      const value = chunk.toString("utf8");
      stderr = append(stderr, value);
      if (onTime) {
        const matches = [...value.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
        const latest = matches.at(-1);
        if (latest) onTime(Number(latest[1]) * 3600 + Number(latest[2]) * 60 + Number(latest[3]));
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(new ParserError("FFMPEG_NOT_AVAILABLE", error.message));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new ParserError("MEDIA_PREPROCESSING_FAILED", `FFmpeg/FFprobe 执行失败（exit ${code}）：${stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ").slice(0, 800)}`));
    });
  });
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function append(current: string, addition: string): string {
  const result = current + addition;
  return result.length <= 1_000_000 ? result : result.slice(-1_000_000);
}
