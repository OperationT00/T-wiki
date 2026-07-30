import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import { ParserError, throwIfAborted, type ParseContext, type SourceBody } from "../parser-types";
import type {
  FrameExtractionOptions,
  VideoFrameCandidate,
  VideoFrameExtractor,
  VideoMetadata
} from "./video-visual-types";

interface ProcessResult { stdout: string; stderr: string }

export class FfmpegFrameExtractor implements VideoFrameExtractor {
  private ffmpegVersion?: string;

  constructor(private readonly configuredPath = "") {}

  async fingerprint(signal: AbortSignal): Promise<string> {
    if (this.ffmpegVersion) return this.ffmpegVersion;
    const [ffmpeg, ffprobe] = await Promise.all([
      runProcess(this.ffmpegExecutable(), ["-version"], signal),
      runProcess(this.ffprobeExecutable(), ["-version"], signal)
    ]);
    const ffmpegLine = ffmpeg.stdout.split(/\r?\n/, 1)[0]?.trim();
    const ffprobeLine = ffprobe.stdout.split(/\r?\n/, 1)[0]?.trim();
    if (!ffmpegLine || !ffprobeLine) throw new ParserError("FFMPEG_NOT_AVAILABLE", "无法读取 FFmpeg/FFprobe 版本");
    this.ffmpegVersion = `${ffmpegLine} | ${ffprobeLine}`.slice(0, 480);
    return this.ffmpegVersion;
  }

  async probe(source: SourceBody, signal: AbortSignal): Promise<VideoMetadata> {
    const executable = this.ffprobeExecutable();
    const result = await runProcess(executable, [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
      "-of", "json",
      "-i", "pipe:0"
    ], signal, source);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(result.stdout) as Record<string, unknown>; }
    catch { throw new ParserError("FFPROBE_RESULT_INVALID", "FFprobe 返回了无效 JSON"); }
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find((item) => item && typeof item === "object"
      && (item as Record<string, unknown>).codec_type === "video") as Record<string, unknown> | undefined;
    if (!video) throw new ParserError("VIDEO_STREAM_MISSING", "媒体文件中没有可解析的视频流");
    const format = parsed.format && typeof parsed.format === "object"
      ? parsed.format as Record<string, unknown>
      : {};
    const durationSeconds = Number(format.duration);
    const width = Number(video.width);
    const height = Number(video.height);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0
      || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new ParserError("VIDEO_METADATA_INVALID", "FFprobe 未返回有效的视频时长或分辨率");
    }
    return {
      durationMs: Math.round(durationSeconds * 1000),
      width: Math.round(width),
      height: Math.round(height),
      videoCodec: typeof video.codec_name === "string" ? video.codec_name : undefined,
      ffmpegVersion: await this.fingerprint(signal)
    };
  }

  async extract(
    sourcePath: string,
    options: FrameExtractionOptions,
    context: ParseContext
  ): Promise<VideoFrameCandidate[]> {
    throwIfAborted(context.signal);
    const fullPattern = join(options.workingDirectory, "frame-%06d.webp");
    const thumbPattern = join(options.workingDirectory, "thumb-%06d.webp");
    const sceneFilter = `gt(scene,${options.sceneThreshold.toFixed(4)})`;
    let result = await this.extractWithFilter(
      sourcePath,
      fullPattern,
      thumbPattern,
      sceneFilter,
      options,
      context
    );
    let frames = await listedFrames(options.workingDirectory, "frame-");
    if (frames.length === 0) {
      context.reportProgress({ phase: "extracting-frames", mode: "indeterminate", message: "未检测到明显场景变化，按时间间隔提取候选画面" });
      result = await this.extractWithFilter(
        sourcePath,
        fullPattern,
        thumbPattern,
        "isnan(prev_selected_t)+gte(t-prev_selected_t,60)",
        options,
        context
      );
      frames = await listedFrames(options.workingDirectory, "frame-");
    }
    const thumbs = await listedFrames(options.workingDirectory, "thumb-");
    const timestamps = parseCandidateMetadata(result.stderr);
    const count = Math.min(frames.length, thumbs.length, options.maxCandidates);
    const output: VideoFrameCandidate[] = [];
    for (let index = 0; index < count; index += 1) {
      const timestampMs = Math.max(0, Math.round((timestamps[index]?.timestampSeconds ?? index * 60) * 1000));
      const quality = timestamps[index];
      if ((quality?.blackPercent ?? 0) >= 95 || (quality?.blurScore ?? 0) >= 0.65) continue;
      output.push({
        frameId: deterministicFrameId(timestampMs),
        timestampMs,
        imagePath: join(options.workingDirectory, frames[index]!),
        thumbnailPath: join(options.workingDirectory, thumbs[index]!),
        mime: "image/webp"
      });
    }
    return deduplicateTimestampIds(output);
  }

  private async extractWithFilter(
    sourcePath: string,
    fullPattern: string,
    thumbPattern: string,
    selectionExpression: string,
    options: FrameExtractionOptions,
    context: ParseContext
  ): Promise<ProcessResult> {
    const filter = [
      `[0:v]select='${selectionExpression}',blackframe=amount=95:threshold=24,blurdetect,mpdecimate,metadata=mode=print,showinfo,split=2[full][thumb]`,
      `[full]scale=w='min(${options.maxWidth},iw)':h=-2[fullout]`,
      "[thumb]scale=w='min(512,iw)':h=-2[thumbout]"
    ].join(";");
    return runProcess(this.ffmpegExecutable(), [
      "-hide_banner", "-nostdin", "-y", "-i", sourcePath,
      "-filter_complex", filter,
      "-map", "[fullout]", "-frames:v", String(options.maxCandidates),
      "-c:v", "libwebp", "-quality", String(options.imageQuality), fullPattern,
      "-map", "[thumbout]", "-frames:v", String(options.maxCandidates),
      "-c:v", "libwebp", "-quality", "72", thumbPattern
    ], context.signal, undefined, (line) => {
      const match = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) return;
      const second = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      context.reportProgress({ phase: "extracting-frames", completed: second, unit: "second", message: "正在提取候选画面" });
    });
  }

  private ffmpegExecutable(): string {
    const configured = this.configuredPath.trim();
    if (!configured) return "ffmpeg";
    if (!/^ffmpeg(?:\.exe)?$/i.test(basename(configured))) {
      throw new ParserError("FFMPEG_PATH_INVALID", "FFmpeg 路径必须指向 ffmpeg 或 ffmpeg.exe");
    }
    return configured;
  }

  private ffprobeExecutable(): string {
    const configured = this.configuredPath.trim();
    if (!configured) return "ffprobe";
    if (!/^ffmpeg(?:\.exe)?$/i.test(basename(configured))) {
      throw new ParserError("FFMPEG_PATH_INVALID", "FFmpeg 路径必须指向 ffmpeg 或 ffmpeg.exe");
    }
    const extension = extname(configured);
    if (!isAbsolute(configured) && dirname(configured) === ".") return `ffprobe${extension}`;
    return resolve(dirname(configured), `ffprobe${extension}`);
  }
}

export function deterministicFrameId(timestampMs: number): string {
  return `frame-t${String(Math.max(0, Math.round(timestampMs))).padStart(10, "0")}`;
}

async function listedFrames(directory: string, prefix: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".webp"))
    .sort((left, right) => left.localeCompare(right));
}

interface CandidateMetadata { timestampSeconds: number; blackPercent?: number; blurScore?: number }

function parseCandidateMetadata(stderr: string): CandidateMetadata[] {
  const output: CandidateMetadata[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const time = line.match(/pts_time:([\d.]+)/)?.[1];
    if (time !== undefined) output.push({ timestampSeconds: Number(time) });
    const current = output.at(-1);
    if (!current) continue;
    const black = line.match(/lavfi\.blackframe\.pblack=([\d.]+)/)?.[1]
      ?? line.match(/pblack:([\d.]+)/)?.[1];
    const blur = line.match(/lavfi\.blur=([\d.]+)/)?.[1];
    if (black !== undefined) current.blackPercent = Number(black);
    if (blur !== undefined) current.blurScore = Number(blur);
  }
  return output.filter((item) => Number.isFinite(item.timestampSeconds));
}

function deduplicateTimestampIds(frames: VideoFrameCandidate[]): VideoFrameCandidate[] {
  const seen = new Set<string>();
  return frames.filter((frame) => {
    if (seen.has(frame.frameId)) return false;
    seen.add(frame.frameId);
    return true;
  });
}

async function runProcess(
  executable: string,
  args: string[],
  signal: AbortSignal,
  stdinSource?: SourceBody,
  onStderrLine?: (line: string) => void
): Promise<ProcessResult> {
  throwIfAborted(signal);
  return new Promise<ProcessResult>((resolvePromise, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let stderrRemainder = "";
    let child;
    try {
      child = spawn(executable, args, { windowsHide: true, shell: false, stdio: [stdinSource ? "pipe" : "ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new ParserError("FFMPEG_NOT_AVAILABLE", `无法启动 ${executable}：${safeError(error)}`));
      return;
    }
    const finishError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(error);
    };
    const abort = (): void => {
      child.kill();
      finishError(new ParserError("PARSE_CANCELLED", "视频画面提取已取消", true));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => finishError(new ParserError(
      "FFMPEG_NOT_AVAILABLE",
      `无法启动 ${executable}：${safeError(error)}`
    )));
    child.stdout?.on("data", (chunk: Buffer) => { stdout = appendLimited(stdout, chunk.toString("utf8")); });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = appendLimited(stderr, text, 2_000_000);
      if (onStderrLine) {
        const lines = `${stderrRemainder}${text}`.split(/\r?\n/);
        stderrRemainder = lines.pop() ?? "";
        for (const line of lines) onStderrLine(line);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (code !== 0) {
        reject(new ParserError("FFMPEG_FAILED", `FFmpeg/FFprobe 执行失败（exit ${code}）：${lastLines(stderr)}`));
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
    const stdin = child.stdin;
    if (stdinSource && stdin) {
      void (async () => {
        try {
          for await (const chunk of stdinSource.openStream()) {
            throwIfAborted(signal);
            if (!stdin.write(chunk)) await once(stdin, "drain");
          }
          stdin.end();
        } catch (error) {
          child.kill();
          finishError(error);
        }
      })();
    }
  });
}

function appendLimited(current: string, addition: string, limit = 512_000): string {
  const result = current + addition;
  return result.length <= limit ? result : result.slice(result.length - limit);
}

function lastLines(value: string): string {
  return value.split(/\r?\n/).filter(Boolean).slice(-5).join(" | ").slice(0, 800);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 300);
}
