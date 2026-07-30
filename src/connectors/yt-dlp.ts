import { spawn, type ChildProcess } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdtemp, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import { detectSource } from "../parsing/parser-registry";
import { ParserError, throwIfAborted, type SourceBody } from "../parsing/parser-types";
import { clearAppTimeout, setAppTimeout } from "../utils/timers";
import { replaceUnsafeFilenameCharacters } from "../utils/text-safety";

export type CookieBrowser = "edge" | "chrome" | "firefox";

export interface YtDlpInfo {
  executable: string;
  version: string;
}

export interface OnlineVideoMetadata {
  id: string;
  title: string;
  originalTitle?: string;
  author?: string;
  authorId?: string;
  description?: string;
  durationMs?: number;
  webpageUrl: string;
  isLive: boolean;
  fileSize?: number;
}

export interface YtDlpDownloadProgress {
  downloadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  speedBytesPerSecond?: number;
}

export interface DownloadedMedia {
  name: string;
  source: SourceBody;
  size: number;
  cleanup(): Promise<void>;
}

export interface YtDlpPort {
  testInstallation(signal: AbortSignal): Promise<YtDlpInfo>;
  inspect(url: string, signal: AbortSignal): Promise<OnlineVideoMetadata>;
  download(
    url: string,
    signal: AbortSignal,
    reportProgress?: (progress: YtDlpDownloadProgress) => void
  ): Promise<DownloadedMedia>;
}

export interface YtDlpRuntimeOptions {
  executablePath?: string;
  ffmpegPath?: string;
  maxDownloadBytes: number;
  timeoutMs: number;
  cookieBrowser?: CookieBrowser;
}

interface ProcessResult { stdout: string; stderr: string }

export class SpawnYtDlpAdapter implements YtDlpPort {
  private executable?: string;

  constructor(private readonly options: YtDlpRuntimeOptions) {}

  async testInstallation(signal: AbortSignal): Promise<YtDlpInfo> {
    try {
      const executable = await this.resolveExecutable();
      const result = await runProcess(executable, ["--version"], signal, Math.min(this.options.timeoutMs, 15_000));
      const version = result.stdout.trim().split(/\r?\n/)[0]?.trim();
      if (!version || version.length > 100) {
        throw new ParserError("YTDLP_VERSION_FAILED", "yt-dlp 未返回有效版本号");
      }
      return { executable, version };
    } catch (error) {
      if (error instanceof ParserError
        && ["YTDLP_NOT_FOUND", "YTDLP_VERSION_FAILED", "DOUYIN_CANCELLED"].includes(error.code)) throw error;
      throw new ParserError("YTDLP_VERSION_FAILED", `无法取得 yt-dlp 版本：${safeProcessMessage(error)}`);
    }
  }

  async inspect(url: string, signal: AbortSignal): Promise<OnlineVideoMetadata> {
    const executable = await this.resolveExecutable();
    const args = ytDlpBaseArguments(this.options.cookieBrowser);
    args.push("--dump-single-json", "--skip-download", "--no-warnings", url);
    const result = await this.execute(executable, args, signal, "DOUYIN_METADATA_FAILED");
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new ParserError("DOUYIN_METADATA_FAILED", "yt-dlp 返回了无法识别的视频信息");
    }
    if (value._type === "playlist" || Array.isArray(value.entries)) {
      throw new ParserError("DOUYIN_PLAYLIST_UNSUPPORTED", "首期只支持单个抖音视频，不支持合集或播放列表");
    }
    const isLive = value.is_live === true || ["is_live", "is_upcoming", "post_live"].includes(String(value.live_status ?? ""));
    if (isLive) throw new ParserError("DOUYIN_LIVE_UNSUPPORTED", "首期不支持抖音直播");
    const webpageUrl = firstString(value.webpage_url, value.original_url, url);
    const id = firstString(value.id, value.display_id);
    const title = firstString(value.title, value.fulltitle, `douyin-${id || "video"}`);
    const duration = finiteNumber(value.duration);
    const fileSize = finiteNumber(value.filesize) ?? finiteNumber(value.filesize_approx);
    if (fileSize !== undefined && fileSize > this.options.maxDownloadBytes) {
      throw new ParserError(
        "DOUYIN_FILE_TOO_LARGE",
        `抖音视频预计大小超过 ${formatMiB(this.options.maxDownloadBytes)} MiB`
      );
    }
    return {
      id,
      title,
      author: optionalString(value.uploader) ?? optionalString(value.channel),
      authorId: optionalString(value.uploader_id) ?? optionalString(value.channel_id),
      description: optionalString(value.description),
      durationMs: duration === undefined ? undefined : Math.round(duration * 1000),
      webpageUrl,
      isLive,
      fileSize
    };
  }

  async download(
    url: string,
    signal: AbortSignal,
    reportProgress?: (progress: YtDlpDownloadProgress) => void
  ): Promise<DownloadedMedia> {
    const executable = await this.resolveExecutable();
    const root = await mkdtemp(join(tmpdir(), "t-wiki-douyin-"));
    const outputTemplate = join(root, "video.%(ext)s");
    const args = ytDlpBaseArguments(this.options.cookieBrowser);
    args.push(
      "--no-warnings",
      "--newline",
      "--max-filesize", String(this.options.maxDownloadBytes),
      "--format", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
      "--merge-output-format", "mp4",
      "--output", outputTemplate,
      "--print", "after_move:__T_WIKI_FILE__:%(filepath)s",
      "--progress-template", "download:__T_WIKI_PROGRESS__:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s",
      ...(this.options.ffmpegPath?.trim() ? ["--ffmpeg-location", this.options.ffmpegPath.trim()] : []),
      url
    );
    let reportedPath: string | undefined;
    try {
      const result = await this.execute(executable, args, signal, "DOUYIN_DOWNLOAD_FAILED", (line) => {
        if (line.startsWith("__T_WIKI_PROGRESS__:")) {
          reportProgress?.(parseProgress(line.slice("__T_WIKI_PROGRESS__:".length)));
        }
      });
      reportedPath = result.stdout.split(/\r?\n/)
        .find((line) => line.startsWith("__T_WIKI_FILE__:"))
        ?.slice("__T_WIKI_FILE__:".length)
        .trim();
      const filePath = await selectOutputFile(root, reportedPath);
      const fileStat = await stat(filePath);
      if (fileStat.size <= 0) throw new ParserError("DOUYIN_MEDIA_INVALID", "yt-dlp 下载了空视频文件");
      if (fileStat.size > this.options.maxDownloadBytes) {
        throw new ParserError(
          "DOUYIN_FILE_TOO_LARGE",
          `抖音视频超过 ${formatMiB(this.options.maxDownloadBytes)} MiB`
        );
      }
      const head = await readFileHead(filePath, 64);
      const detected = detectSource(basename(filePath), head);
      if (detected.kind !== "video") {
        throw new ParserError("DOUYIN_MEDIA_INVALID", "yt-dlp 下载结果不是有效视频文件");
      }
      await verifyVideoStream(filePath, this.options.ffmpegPath, signal, Math.min(this.options.timeoutMs, 30_000));
      return {
        name: `${safeFileName(basename(filePath, extname(filePath)))}.${detected.extension}`,
        size: fileStat.size,
        source: sourceBodyFromFile(filePath, fileStat.size),
        cleanup: () => rm(root, { recursive: true, force: true })
      };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      if (error instanceof ParserError) throw error;
      throw new ParserError("DOUYIN_DOWNLOAD_FAILED", safeProcessMessage(error), true);
    }
  }

  private async execute(
    executable: string,
    args: string[],
    signal: AbortSignal,
    fallbackCode: string,
    onStdoutLine?: (line: string) => void
  ): Promise<ProcessResult> {
    try {
      return await runProcess(executable, args, signal, this.options.timeoutMs, onStdoutLine);
    } catch (error) {
      if (error instanceof ParserError) throw error;
      const message = safeProcessMessage(error);
      if (cookieDatabaseUnavailable(message)) {
        const browser = this.options.cookieBrowser
          ? `${this.options.cookieBrowser[0]!.toLocaleUpperCase()}${this.options.cookieBrowser.slice(1)}`
          : "所选浏览器";
        const dpapi = /failed to decrypt with dpapi/i.test(message);
        throw new ParserError(
          "DOUYIN_COOKIE_REQUIRED",
          dpapi
            ? `Windows DPAPI 无法解密 ${browser} Cookie。请改用已登录抖音的 Firefox，并在 T-Wiki“在线视频 / 抖音”中将 Cookie 浏览器切换为 Firefox`
            : `无法读取 ${browser} Cookie 数据库。请完全退出该浏览器（包括后台进程）后重试，或在 T-Wiki 设置中选择另一个已登录浏览器`,
          true
        );
      }
      if (requiresFreshCookies(message)) {
        throw new ParserError(
          "DOUYIN_COOKIE_REQUIRED",
          "抖音要求有效的浏览器登录状态；可在本次任务明确授权后读取浏览器 Cookie"
        );
      }
      if (/private video|not available|login required|permission|drm|protected content|无权限|私密/i.test(message)) {
        throw new ParserError("DOUYIN_PRIVATE_UNSUPPORTED", "该视频不是无需授权即可处理的公开视频");
      }
      throw new ParserError(fallbackCode, message || "yt-dlp 执行失败", /network|timed out|http error 5\d\d|429/i.test(message));
    }
  }

  private async resolveExecutable(): Promise<string> {
    if (!this.executable) this.executable = await resolveYtDlpExecutable(this.options.executablePath);
    return this.executable;
  }
}

export function ytDlpBaseArguments(cookieBrowser?: CookieBrowser): string[] {
  return [
    "--ignore-config",
    "--no-playlist",
    ...(cookieBrowser ? ["--cookies-from-browser", cookieBrowser] : [])
  ];
}

export async function resolveYtDlpExecutable(configured?: string): Promise<string> {
  const candidate = configured?.trim();
  if (candidate) {
    if (!isAbsolute(candidate)) {
      throw new ParserError("YTDLP_NOT_FOUND", "手动配置的 yt-dlp 路径必须是绝对路径；留空可自动从 PATH 查找");
    }
    if (await isExecutable(candidate)) return resolve(candidate);
    throw new ParserError("YTDLP_NOT_FOUND", "配置的 yt-dlp 可执行文件不存在或不可访问");
  }
  const executableName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  for (const directory of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!directory.trim()) continue;
    const path = join(directory.replace(/^"|"$/g, ""), executableName);
    if (await isExecutable(path)) return resolve(path);
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      const links = join(local, "Microsoft", "WinGet", "Links", "yt-dlp.exe");
      if (await isExecutable(links)) return resolve(links);
      const packages = join(local, "Microsoft", "WinGet", "Packages");
      try {
        const directories = await readdir(packages, { withFileTypes: true });
        for (const entry of directories
          .filter((item) => item.isDirectory() && item.name.toLocaleLowerCase().startsWith("yt-dlp.yt-dlp_"))
          .sort((left, right) => right.name.localeCompare(left.name))) {
          const path = join(packages, entry.name, "yt-dlp.exe");
          if (await isExecutable(path)) return resolve(path);
        }
      } catch {
        // WinGet is optional.
      }
    }
  }
  throw new ParserError("YTDLP_NOT_FOUND", "未找到 yt-dlp；请安装后重新启动 Obsidian，或在设置中填写 yt-dlp.exe 绝对路径");
}

async function runProcess(
  executable: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
  onStdoutLine?: (line: string) => void,
  executableLabel = "yt-dlp"
): Promise<ProcessResult> {
  throwIfAborted(signal);
  return new Promise<ProcessResult>((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(new ParserError("YTDLP_NOT_FOUND", `无法启动 ${executableLabel}：${safeProcessMessage(error)}`));
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutRemainder = "";
    let timedOut = false;
    const timeout = setAppTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, Math.max(1_000, timeoutMs));
    const cleanup = (): void => {
      clearAppTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = (): void => {
      terminateProcessTree(child);
      fail(new ParserError("DOUYIN_CANCELLED", "抖音视频处理已取消", true));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => fail(new ParserError("YTDLP_NOT_FOUND", `无法启动 ${executableLabel}：${safeProcessMessage(error)}`)));
    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = appendLimited(stdout, text, 6_000_000);
      if (onStdoutLine) {
        const lines = `${stdoutRemainder}${text}`.split(/\r?\n/);
        stdoutRemainder = lines.pop() ?? "";
        for (const line of lines) onStdoutLine(line);
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"), 1_000_000);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) {
        reject(new ParserError("DOUYIN_TIMEOUT", "yt-dlp 处理抖音视频超时", true));
      } else if (signal.aborted) {
        reject(new ParserError("DOUYIN_CANCELLED", "抖音视频处理已取消", true));
      } else if (code !== 0) {
        reject(new Error(sanitizeDiagnostic(lastLines(stderr || stdout))));
      } else {
        if (stdoutRemainder && onStdoutLine) onStdoutLine(stdoutRemainder);
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore"
    });
    const fallback = (): void => {
      if (!child.killed) child.kill();
    };
    killer.once("error", fallback);
    killer.once("close", (code) => {
      if (code !== 0) fallback();
    });
    killer.unref();
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

async function selectOutputFile(root: string, reportedPath?: string): Promise<string> {
  const rootReal = await realpath(root);
  let candidate = reportedPath ? resolve(reportedPath) : undefined;
  if (!candidate) {
    const entries = await readdir(root, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && !/\.(?:part|ytdl|json)$/i.test(entry.name));
    if (files.length !== 1) throw new ParserError("DOUYIN_MEDIA_INVALID", "yt-dlp 未生成唯一的视频文件");
    candidate = join(root, files[0]!.name);
  }
  if ((await lstat(candidate)).isSymbolicLink()) {
    throw new ParserError("DOUYIN_MEDIA_INVALID", "yt-dlp 输出不能是符号链接");
  }
  const fileReal = await realpath(candidate);
  const prefix = `${rootReal}${process.platform === "win32" ? "\\" : "/"}`.toLocaleLowerCase();
  if (!fileReal.toLocaleLowerCase().startsWith(prefix)) {
    throw new ParserError("DOUYIN_MEDIA_INVALID", "yt-dlp 输出路径越过了受控临时目录");
  }
  return fileReal;
}

async function verifyVideoStream(filePath: string, ffmpegPath: string | undefined, signal: AbortSignal, timeoutMs: number): Promise<void> {
  const ffprobe = ffprobeExecutable(ffmpegPath);
  try {
    const result = await runProcess(ffprobe, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_type",
      "-of", "json",
      filePath
    ], signal, timeoutMs, undefined, "FFprobe");
    const parsed = JSON.parse(result.stdout) as { streams?: Array<{ codec_type?: string }> };
    if (!parsed.streams?.some((stream) => stream.codec_type === "video")) {
      throw new ParserError("DOUYIN_MEDIA_INVALID", "下载结果不包含视频流");
    }
  } catch (error) {
    if (error instanceof ParserError && ["DOUYIN_CANCELLED", "DOUYIN_TIMEOUT"].includes(error.code)) throw error;
    throw new ParserError("DOUYIN_MEDIA_INVALID", `无法验证下载视频流：${safeProcessMessage(error)}`);
  }
}

function ffprobeExecutable(ffmpegPath?: string): string {
  const configured = ffmpegPath?.trim();
  if (!configured) return process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const extension = extname(configured).toLocaleLowerCase();
  const directory = extension === ".exe" || basename(configured).toLocaleLowerCase() === "ffmpeg"
    ? dirname(configured)
    : configured;
  return join(directory, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
}

function sourceBodyFromFile(path: string, expectedSize: number): SourceBody {
  return {
    size: expectedSize,
    async readHead(maxBytes) { return readFileHead(path, maxBytes); },
    async readAll(maxBytes) {
      if (expectedSize > maxBytes) throw new ParserError("FILE_TOO_LARGE", `Source exceeds ${maxBytes} bytes`);
      const chunks: Buffer[] = [];
      for await (const chunk of createReadStream(path)) chunks.push(chunk as Buffer);
      return new Uint8Array(Buffer.concat(chunks));
    },
    async *openStream() {
      if ((await stat(path)).size !== expectedSize) throw new ParserError("DOUYIN_MEDIA_INVALID", "临时视频在导入前发生变化");
      for await (const chunk of createReadStream(path)) yield new Uint8Array(chunk as Buffer);
    }
  };
}

async function readFileHead(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const bytes = new Uint8Array(Math.max(0, maxBytes));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.slice(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try { await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return true; }
  catch { return false; }
}

function parseProgress(value: string): YtDlpDownloadProgress {
  const [downloadedValue, totalValue, estimatedValue, speedValue] = value.split("|");
  const downloadedBytes = finiteNumber(downloadedValue);
  const totalBytes = finiteNumber(totalValue) ?? finiteNumber(estimatedValue);
  const speedBytesPerSecond = finiteNumber(speedValue);
  return {
    downloadedBytes,
    totalBytes,
    percent: downloadedBytes !== undefined && totalBytes !== undefined && totalBytes > 0
      ? Math.min(100, downloadedBytes / totalBytes * 100)
      : undefined,
    speedBytesPerSecond
  };
}

function requiresFreshCookies(value: string): boolean {
  return /fresh cookies|cookies-from-browser|sign in to confirm|captcha|verify you are (?:human|not a bot)|风控验证|验证码/i.test(value);
}

function cookieDatabaseUnavailable(value: string): boolean {
  return /failed to decrypt with dpapi|could not copy .*cookie database|failed to (?:copy|decrypt|read).*cookies?|cookie database.*(?:locked|unavailable)|browser.*cookies?.*(?:locked|database)/i.test(value);
}

export function sanitizeDiagnostic(value: string): string {
  const userProfile = process.env.USERPROFILE;
  const homeDirectory = process.env.HOME;
  let result = value
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, "$1[redacted]")
    .replace(/((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|key|signature|sign|auth|authorization|cookie)=[^&\s]*)/gi, "[redacted]")
    .replace(/(?:Bearer\s+)?[A-Za-z0-9._-]{32,}/g, "[redacted]");
  if (userProfile) result = result.replaceAll(userProfile, "%USERPROFILE%");
  if (homeDirectory && homeDirectory !== userProfile) result = result.replaceAll(homeDirectory, "%HOME%");
  return result.replace(/[\r\n]+/g, " ").slice(0, 1200);
}

function safeProcessMessage(error: unknown): string {
  return sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
}

function appendLimited(current: string, addition: string, limit: number): string {
  const next = current + addition;
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function lastLines(value: string): string {
  return value.split(/\r?\n/).filter(Boolean).slice(-8).join(" | ");
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value && value !== "NA") {
    const parsed = Number(value.trim().replace(/%$/, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstString(...values: unknown[]): string {
  return values.find((value) => typeof value === "string" && value.trim())?.toString().trim() ?? "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeFileName(value: string): string {
  return replaceUnsafeFilenameCharacters(value.normalize("NFKC"))
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120) || "douyin-video";
}

function formatMiB(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}
