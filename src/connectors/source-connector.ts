import type { EventRef, TAbstractFile, TFile } from "obsidian";

import type { SourceManifest, SourceKind } from "../types";
import type { IntakeProvenance } from "../services/intake-service";
import type { WebPageFetcherPort } from "./web-page-fetcher";

export interface ConnectorScanResult {
  imported: number;
  duplicates: number;
  failed: Array<{ path: string; message: string }>;
}

export interface SourceConnectorContext {
  importSource(
    name: string,
    bytes: Uint8Array,
    provenance: IntakeProvenance
  ): Promise<{ manifest: SourceManifest; duplicate: boolean }>;
  reportError?(connectorId: string, path: string, error: unknown): void;
}

export interface SourceConnector {
  readonly id: string;
  start(context: SourceConnectorContext): Promise<void>;
  scan?(): Promise<ConnectorScanResult>;
  stop(): Promise<void>;
}

export class FilePickerConnector implements SourceConnector {
  readonly id = "file-picker";
  private context?: SourceConnectorContext;

  async start(context: SourceConnectorContext): Promise<void> {
    this.context = context;
  }

  async importFiles(files: File[]): Promise<SourceManifest[]> {
    if (!this.context) throw new Error("FilePickerConnector 尚未启动");
    const output: SourceManifest[] = [];
    for (const file of files) {
      output.push((await this.context.importSource(
        file.name,
        new Uint8Array(await file.arrayBuffer()),
        { acquiredBy: "file-picker" }
      )).manifest);
    }
    return output;
  }

  async stop(): Promise<void> {
    this.context = undefined;
  }
}

export interface UrlCaptureRequest {
  url: string;
  signal?: AbortSignal;
  reportProgress?(phase: "download" | "parse" | "complete"): void;
}

export interface UrlCaptureResult {
  manifest: SourceManifest;
  duplicate: boolean;
  requestedUrl: string;
  finalUrl: string;
}

export class UrlCaptureConnector implements SourceConnector {
  readonly id = "url-capture";
  private context?: SourceConnectorContext;

  constructor(private readonly fetcher: WebPageFetcherPort) {}

  async start(context: SourceConnectorContext): Promise<void> {
    this.context = context;
  }

  async capture(request: UrlCaptureRequest): Promise<UrlCaptureResult> {
    if (!this.context) throw new Error("UrlCaptureConnector 尚未启动");
    const capturedAt = new Date().toISOString();
    request.reportProgress?.("download");
    const fetched = await this.fetcher.fetch(request.url, request.signal);
    request.reportProgress?.("parse");
    const imported = await this.context.importSource(
      sourceNameForUrl(fetched.finalUrl),
      fetched.bytes,
      {
        kind: "web",
        uri: fetched.finalUrl,
        requestedUri: fetched.requestedUrl,
        capturedAt,
        acquiredBy: this.id,
        capture: {
          status: fetched.status,
          contentType: fetched.contentType,
          ...(fetched.etag ? { etag: fetched.etag } : {}),
          ...(fetched.lastModified ? { lastModified: fetched.lastModified } : {})
        }
      }
    );
    request.reportProgress?.("complete");
    return {
      ...imported,
      requestedUrl: fetched.requestedUrl,
      finalUrl: fetched.finalUrl
    };
  }

  async stop(): Promise<void> {
    this.context = undefined;
  }
}

export function sourceNameForUrl(input: string): string {
  const url = new URL(input);
  const lastSegment = url.pathname.split("/").filter(Boolean).at(-1) ?? url.hostname;
  let decoded = lastSegment;
  try {
    decoded = decodeURIComponent(lastSegment);
  } catch {
    // Keep the encoded path segment when it contains malformed escapes.
  }
  const basename = decoded
    .replace(/\.(?:html?|xhtml)$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || url.hostname;
  return `${basename}.html`;
}

export interface WebClipperOptions {
  inboxPath: string;
  scanExistingOnStartup: boolean;
  settleDelayMs?: number;
  settleAttempts?: number;
}

interface VaultLike {
  on(name: "create", callback: (file: TAbstractFile) => unknown): EventRef;
  on(name: "rename", callback: (file: TAbstractFile, oldPath: string) => unknown): EventRef;
  offref(ref: EventRef): void;
  getMarkdownFiles(): TFile[];
  getAbstractFileByPath(path: string): TAbstractFile | null;
  readBinary(file: TFile): Promise<ArrayBuffer>;
}

export class WebClipperInboxConnector implements SourceConnector {
  readonly id = "obsidian-web-clipper";
  private context?: SourceConnectorContext;
  private refs: EventRef[] = [];
  private readonly pending = new Map<string, Promise<void>>();
  private readonly inboxPath: string;

  constructor(
    private readonly vault: VaultLike,
    options: WebClipperOptions
  ) {
    this.options = {
      ...options,
      settleDelayMs: options.settleDelayMs ?? 750,
      settleAttempts: options.settleAttempts ?? 5
    };
    this.inboxPath = validateInboxPath(options.inboxPath);
  }

  private readonly options: Required<WebClipperOptions>;

  async start(context: SourceConnectorContext): Promise<void> {
    if (this.context) return;
    this.context = context;
    this.refs.push(
      this.vault.on("create", (file) => this.onCandidate(file)),
      this.vault.on("rename", (file) => this.onCandidate(file))
    );
    if (this.options.scanExistingOnStartup) await this.scan();
  }

  async scan(): Promise<ConnectorScanResult> {
    if (!this.context) throw new Error("WebClipperInboxConnector 尚未启动");
    const result: ConnectorScanResult = { imported: 0, duplicates: 0, failed: [] };
    for (const file of this.vault.getMarkdownFiles().filter((candidate) => this.accepts(candidate.path))) {
      try {
        const imported = await this.importStable(file.path);
        if (imported.duplicate) result.duplicates += 1;
        else result.imported += 1;
      } catch (error) {
        result.failed.push({
          path: file.path,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return result;
  }

  async stop(): Promise<void> {
    for (const ref of this.refs) this.vault.offref(ref);
    this.refs = [];
    this.context = undefined;
    await Promise.allSettled(this.pending.values());
    this.pending.clear();
  }

  private onCandidate(file: TAbstractFile): void {
    if (!this.accepts(file.path) || !isTFile(file)) return;
    if (this.pending.has(file.path)) return;
    const task = this.importStable(file.path)
      .then(() => undefined)
      .catch((error) => this.context?.reportError?.(this.id, file.path, error))
      .finally(() => this.pending.delete(file.path));
    this.pending.set(file.path, task);
  }

  private async importStable(path: string): Promise<{ manifest: SourceManifest; duplicate: boolean }> {
    if (!this.context) throw new Error("WebClipperInboxConnector 尚未启动");
    let previous: { size: number; mtime: number } | undefined;
    for (let attempt = 0; attempt < this.options.settleAttempts; attempt += 1) {
      const current = this.vault.getAbstractFileByPath(path);
      if (!isTFile(current)) throw new Error(`Clipper 文件不存在：${path}`);
      const snapshot = { size: current.stat.size, mtime: current.stat.mtime };
      if (previous && previous.size === snapshot.size && previous.mtime === snapshot.mtime) {
        const bytes = new Uint8Array(await this.vault.readBinary(current));
        return this.context.importSource(current.name, bytes, {
          kind: "web" satisfies SourceKind,
          acquiredBy: this.id
        });
      }
      previous = snapshot;
      await delay(this.options.settleDelayMs);
    }
    throw new Error(`Clipper 文件在等待期内仍在变化：${path}`);
  }

  private accepts(path: string): boolean {
    const normalized = normalizeVaultPath(path);
    return normalized.toLocaleLowerCase().endsWith(".md")
      && normalized.startsWith(`${this.inboxPath}/`);
  }
}

export function validateInboxPath(input: string): string {
  const path = normalizeVaultPath(input).replace(/\/$/, "");
  if (!path || path === "." || path.split("/").includes("..")) {
    throw new Error("Web Clipper Inbox 路径无效");
  }
  const protectedRoots = ["raw", "wiki", ".llm-wiki", ".obsidian"];
  if (protectedRoots.some((root) =>
    path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`)
  )) {
    throw new Error(`Web Clipper Inbox 不能与系统目录重叠：${path}`);
  }
  return path;
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

function isTFile(file: TAbstractFile | null): file is TFile {
  return Boolean(file && "stat" in file && "extension" in file);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
