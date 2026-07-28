import { strFromU8, unzipSync } from "fflate";

import type { HttpClientPort, HttpResponse } from "../http-client";
import {
  ParserError,
  throwIfAborted,
  type DocumentParser,
  type ParseContext,
  type ParseInput,
  type ProbeResult
} from "../parser-types";
import type { ParseIssue, ParsePayload, ParsedAsset } from "../../types";

export type MinerUProtocol = "cloud-v4" | "self-hosted";
export type MinerUCloudModelVersion = "pipeline" | "vlm";
export type MinerUCloudLanguage =
  | "ch" | "ch_server" | "en" | "japan" | "korean" | "chinese_cht"
  | "ta" | "te" | "ka" | "el" | "th" | "latin" | "arabic" | "cyrillic"
  | "east_slavic" | "devanagari";

const CLOUD_LANGUAGES = new Set([
  "ch", "ch_server", "en", "japan", "korean", "chinese_cht", "ta", "te", "ka", "el",
  "th", "latin", "arabic", "cyrillic", "east_slavic", "devanagari"
]);

export interface MinerUOptions {
  protocol: MinerUProtocol;
  baseUrl: string;
  modelVersion: string;
  language: string;
  enableTable: boolean;
  enableFormula: boolean;
  isOcr: boolean;
  pollIntervalMs: number;
  taskTimeoutMs: number;
}

export interface MinerUCredentials {
  getToken(protocol: MinerUProtocol): Promise<string>;
}

export interface MinerUTask {
  protocol: MinerUProtocol;
  id: string;
  fileName: string;
  dataId?: string;
}

export interface MinerUResult {
  markdown: string;
  assets: ParsedAsset[];
  issues: ParseIssue[];
}

export interface MinerUTransport {
  readonly protocol: MinerUProtocol;
  testConnection(options: MinerUOptions): Promise<{ ok: boolean; message: string }>;
  submit(input: ParseInput, options: MinerUOptions, context?: ParseContext): Promise<MinerUTask>;
  poll(task: MinerUTask, options: MinerUOptions, context: ParseContext): Promise<MinerUResult>;
  resume(task: MinerUTask, options: MinerUOptions, context: ParseContext): Promise<MinerUResult>;
}

export class MinerUParser implements DocumentParser {
  readonly descriptor = {
    id: "mineru-http",
    version: "1.1.0",
    execution: "remote",
    supportedKinds: ["pdf"],
    capabilities: { sourceMap: false, assets: true, resumable: true }
  } as const;

  private readonly transports: Record<MinerUProtocol, MinerUTransport>;

  constructor(http: HttpClientPort, credentials: MinerUCredentials) {
    this.transports = {
      "cloud-v4": new MinerUCloudV4Transport(http, credentials),
      "self-hosted": new MinerUSelfHostedTransport(http, credentials)
    };
  }

  validateOptions(options: Readonly<Record<string, unknown>>): void {
    parseMinerUOptions(options);
  }

  probe(input: ParseInput): ProbeResult {
    const magic = new TextDecoder("ascii").decode(input.bytes.subarray(0, 5)) === "%PDF-";
    return {
      supported: magic,
      confidence: magic ? 1 : 0,
      detectedMime: magic ? "application/pdf" : undefined,
      reason: magic ? undefined : "MinerU 首期仅接收有效 PDF"
    };
  }

  async parse(input: ParseInput, context: ParseContext): Promise<ParsePayload> {
    if (!this.probe(input).supported) throw new ParserError("UNSUPPORTED_FORMAT", "MinerU 首期仅支持 PDF");
    throwIfAborted(context.signal);
    const options = parseMinerUOptions(context.options);
    const transport = this.transports[options.protocol];
    context.reportProgress({ phase: "mineru-submit", message: "正在上传并提交 MinerU 任务" });
    const task = await transport.submit(input, options, context);
    context.reportProgress({ phase: "mineru-poll", message: "MinerU 任务已提交，等待解析" });
    throwIfAborted(context.signal);
    await context.saveResumeToken(serializeResumeToken(task));
    const result = await transport.poll(task, options, context);
    return resultToPayload(result);
  }

  async resume(input: ParseInput, token: string, context: ParseContext): Promise<ParsePayload> {
    throwIfAborted(context.signal);
    const options = parseMinerUOptions(context.options);
    const task = parseResumeToken(token);
    if (task.protocol !== options.protocol || task.fileName !== input.name
      || (task.dataId !== undefined && task.dataId !== input.sourceId)) {
      throw new ParserError("MINERU_RESUME_MISMATCH", "MinerU resume token 与当前配置或文件不一致");
    }
    const result = await this.transports[task.protocol].resume(task, options, context);
    return resultToPayload(result);
  }

  async testConnection(optionsInput: Readonly<Record<string, unknown>>): Promise<{ ok: boolean; message: string }> {
    const options = parseMinerUOptions(optionsInput);
    return this.transports[options.protocol].testConnection(options);
  }
}

export class MinerUCloudV4Transport implements MinerUTransport {
  readonly protocol = "cloud-v4" as const;

  constructor(
    private readonly http: HttpClientPort,
    private readonly credentials: MinerUCredentials
  ) {}

  async testConnection(options: MinerUOptions): Promise<{ ok: boolean; message: string }> {
    const token = await this.requireToken();
    const response = await safeRequest(this.http, {
      url: joinUrl(options.baseUrl, "/api/v4/extract-results/batch/00000000-0000-0000-0000-000000000000"),
      headers: { authorization: `Bearer ${token}` }
    }, "MINERU_CONNECTION_FAILED");
    if (response.status === 404) throw new ParserError("MINERU_CONNECTION_FAILED", "MinerU Cloud Base URL 不正确");
    assertHttp(response, "MINERU_CONNECTION_FAILED");
    const envelope = cloudEnvelope(response, "MINERU_CONNECTION_FAILED", true);
    const apiCode = normalizeApiCode(envelope.code);
    if (apiCode !== "0" && apiCode !== "-60012") {
      throw cloudApiError(envelope, "MINERU_CONNECTION_FAILED");
    }
    return { ok: true, message: `Cloud 服务可达 · ${new URL(options.baseUrl).host}` };
  }

  async submit(input: ParseInput, options: MinerUOptions, context?: ParseContext): Promise<MinerUTask> {
    const token = await this.requireToken();
    const response = await safeRequest(this.http, {
      url: joinUrl(options.baseUrl, "/api/v4/file-urls/batch"),
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        files: [{ name: input.name, data_id: input.sourceId, is_ocr: options.isOcr }],
        model_version: options.modelVersion,
        language: options.language,
        enable_table: options.enableTable,
        enable_formula: options.enableFormula
      })
    }, "MINERU_SUBMIT_FAILED");
    assertHttp(response, "MINERU_SUBMIT_FAILED");
    const data = record(cloudEnvelope(response, "MINERU_SUBMIT_FAILED").data);
    const batchId = stringValue(data.batch_id);
    const uploadUrl = arrayValue(data.file_urls).map(String)[0];
    if (!batchId || typeof uploadUrl !== "string" || !isHttpUrl(uploadUrl)) {
      throw invalidResult("MinerU Cloud 未返回有效的 batch_id/file_url");
    }
    await uploadWithRetry(this.http, uploadUrl, input.bytes, options.pollIntervalMs, context?.signal);
    return { protocol: this.protocol, id: batchId, fileName: input.name, dataId: input.sourceId };
  }

  poll(task: MinerUTask, options: MinerUOptions, context: ParseContext): Promise<MinerUResult> {
    return this.waitForResult(task, options, context);
  }

  resume(task: MinerUTask, options: MinerUOptions, context: ParseContext): Promise<MinerUResult> {
    return this.waitForResult(task, options, context);
  }

  private async waitForResult(
    task: MinerUTask,
    options: MinerUOptions,
    context: ParseContext
  ): Promise<MinerUResult> {
    const token = await this.requireToken();
    const deadline = Date.now() + options.taskTimeoutMs;
    let delayMs = options.pollIntervalMs;
    while (Date.now() < deadline) {
      throwIfAborted(context.signal);
      const response = await pollRequest(this.http, {
        url: joinUrl(options.baseUrl, `/api/v4/extract-results/batch/${encodeURIComponent(task.id)}`),
        headers: { authorization: `Bearer ${token}` }
      }, delayMs, context);
      if (!response) {
        delayMs = Math.min(10_000, Math.max(options.pollIntervalMs, Math.round(delayMs * 1.5)));
        continue;
      }
      assertHttp(response, "MINERU_POLL_FAILED");
      let envelope: CloudEnvelope;
      try {
        envelope = cloudEnvelope(response, "MINERU_POLL_FAILED");
      } catch (error) {
        if (!(error instanceof ParserError) || !error.retryable) throw error;
        await waitWithSignal(retryDelay(response, delayMs), context.signal);
        delayMs = nextDelay(delayMs, options.pollIntervalMs);
        continue;
      }
      const item = matchingTaskResult(envelope.data, task);
      const state = taskState(item);
      reportMinerUProgress(context, item, state);
      if (state === "failed") throw new ParserError("MINERU_TASK_FAILED", sanitizeMessage(taskMessage(item)), false);
      if (state === "done") {
        const zipUrl = findStringByKeys(item, ["full_zip_url"]);
        if (!zipUrl || !isHttpUrl(zipUrl)) throw invalidResult("MinerU Cloud 完成但缺少有效的结果 ZIP URL");
        context.reportProgress({
          phase: "mineru-download",
          completed: 0,
          total: 1,
          unit: "item",
          message: "正在下载 MinerU 解析结果"
        });
        const archive = await safeRequest(this.http, { url: zipUrl }, "MINERU_RESULT_DOWNLOAD_FAILED");
        assertHttp(archive, "MINERU_RESULT_DOWNLOAD_FAILED");
        const result = parseMinerUArchive(archive.bytes);
        context.reportProgress({
          phase: "mineru-download",
          completed: 1,
          total: 1,
          unit: "item",
          message: "MinerU 解析结果下载完成"
        });
        return result;
      }
      if (!["waiting-file", "pending", "running", "converting"].includes(state)) {
        throw invalidResult(`MinerU Cloud 返回未知任务状态：${state || "<empty>"}`);
      }
      await waitWithSignal(retryDelay(response, delayMs), context.signal);
      delayMs = nextDelay(delayMs, options.pollIntervalMs);
    }
    throw new ParserError("MINERU_TIMEOUT", "MinerU Cloud 任务超时", true);
  }

  private async requireToken(): Promise<string> {
    const token = (await this.credentials.getToken(this.protocol)).trim();
    if (!token) throw new ParserError("MINERU_AUTH_MISSING", "MinerU Cloud Token 未配置");
    return token;
  }
}

export class MinerUSelfHostedTransport implements MinerUTransport {
  readonly protocol = "self-hosted" as const;

  constructor(
    private readonly http: HttpClientPort,
    private readonly credentials: MinerUCredentials
  ) {}

  async testConnection(options: MinerUOptions): Promise<{ ok: boolean; message: string }> {
    const response = await safeRequest(this.http, {
      url: joinUrl(options.baseUrl, "/health"),
      headers: await this.authHeaders()
    }, "MINERU_CONNECTION_FAILED");
    assertHttp(response, "MINERU_CONNECTION_FAILED");
    const protocol = stringValue(record(response.json).protocol_version);
    return { ok: true, message: protocol ? `连接成功 · protocol ${protocol}` : "连接成功" };
  }

  async submit(input: ParseInput, options: MinerUOptions): Promise<MinerUTask> {
    const multipart = buildMultipart(input, options);
    const response = await safeRequest(this.http, {
      url: joinUrl(options.baseUrl, "/tasks"),
      method: "POST",
      headers: { ...(await this.authHeaders()), "content-type": multipart.contentType },
      body: multipart.body
    }, "MINERU_SUBMIT_FAILED");
    assertHttp(response, "MINERU_SUBMIT_FAILED");
    const root = record(response.json);
    const taskId = stringValue(root.task_id) || stringValue(record(root.data).task_id);
    if (!taskId) throw invalidResult("自托管 MinerU 未返回 task_id");
    return { protocol: this.protocol, id: taskId, fileName: input.name };
  }

  poll(task: MinerUTask, options: MinerUOptions, context: ParseContext): Promise<MinerUResult> {
    return this.waitForResult(task, options, context);
  }

  resume(task: MinerUTask, options: MinerUOptions, context: ParseContext): Promise<MinerUResult> {
    return this.waitForResult(task, options, context);
  }

  private async waitForResult(
    task: MinerUTask,
    options: MinerUOptions,
    context: ParseContext
  ): Promise<MinerUResult> {
    const deadline = Date.now() + options.taskTimeoutMs;
    let delayMs = options.pollIntervalMs;
    while (Date.now() < deadline) {
      throwIfAborted(context.signal);
      const response = await pollRequest(this.http, {
        url: joinUrl(options.baseUrl, `/tasks/${encodeURIComponent(task.id)}`),
        headers: await this.authHeaders()
      }, delayMs, context);
      if (!response) {
        delayMs = Math.min(10_000, Math.max(options.pollIntervalMs, Math.round(delayMs * 1.5)));
        continue;
      }
      assertHttp(response, "MINERU_POLL_FAILED");
      const root = record(response.json);
      const state = taskState(root);
      reportMinerUProgress(context, root, state || "pending");
      if (state === "failed" || state === "error") {
        throw new ParserError("MINERU_TASK_FAILED", sanitizeMessage(taskMessage(root)), false);
      }
      if (state === "done" || state === "completed" || state === "success") {
        context.reportProgress({
          phase: "mineru-download",
          completed: 0,
          total: 1,
          unit: "item",
          message: "正在下载 MinerU 解析结果"
        });
        const result = await safeRequest(this.http, {
          url: joinUrl(options.baseUrl, `/tasks/${encodeURIComponent(task.id)}/result`),
          headers: await this.authHeaders()
        }, "MINERU_RESULT_DOWNLOAD_FAILED");
        assertHttp(result, "MINERU_RESULT_DOWNLOAD_FAILED");
        const parsed = parseMinerUResponse(result);
        context.reportProgress({
          phase: "mineru-download",
          completed: 1,
          total: 1,
          unit: "item",
          message: "MinerU 解析结果下载完成"
        });
        return parsed;
      }
      await waitWithSignal(retryDelay(response, delayMs), context.signal);
      delayMs = Math.min(10_000, Math.max(options.pollIntervalMs, Math.round(delayMs * 1.5)));
    }
    throw new ParserError("MINERU_TIMEOUT", "自托管 MinerU 任务超时", true);
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = (await this.credentials.getToken(this.protocol)).trim();
    return token ? { authorization: `Bearer ${token}` } : {};
  }
}

export function parseMinerUOptions(input: Readonly<Record<string, unknown>>): MinerUOptions {
  if (input.protocol !== undefined && input.protocol !== "cloud-v4" && input.protocol !== "self-hosted") {
    throw new ParserError("INVALID_PARSER_OPTIONS", "MinerU protocol 必须是 cloud-v4 或 self-hosted");
  }
  const protocol = input.protocol === "self-hosted" ? "self-hosted" : "cloud-v4";
  const defaultUrl = protocol === "cloud-v4" ? "https://mineru.net" : "http://127.0.0.1:8000";
  const baseUrl = String(input.baseUrl ?? defaultUrl).trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ParserError("INVALID_PARSER_OPTIONS", "MinerU Base URL 无效");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ParserError("INVALID_PARSER_OPTIONS", "MinerU Base URL 仅支持 HTTP/HTTPS");
  }
  if (url.username || url.password
    || [...url.searchParams.keys()].some((key) => /token|secret|password|api[_-]?key|auth|signature/i.test(key))) {
    throw new ParserError("INVALID_PARSER_OPTIONS", "MinerU Base URL 不能包含凭据或敏感查询参数");
  }
  if (url.search || url.hash) {
    throw new ParserError("INVALID_PARSER_OPTIONS", "MinerU Base URL 不能包含查询参数或片段");
  }
  if (protocol === "cloud-v4" && url.protocol !== "https:") {
    throw new ParserError("INVALID_PARSER_OPTIONS", "MinerU Cloud 必须使用 HTTPS");
  }
  if (protocol === "self-hosted" && url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new ParserError("INVALID_PARSER_OPTIONS", "非本机自托管 MinerU 必须使用 HTTPS");
  }
  const modelVersion = String(input.modelVersion ?? "vlm");
  const language = String(input.language ?? "ch");
  if (protocol === "cloud-v4" && modelVersion !== "pipeline" && modelVersion !== "vlm") {
    throw new ParserError("INVALID_PARSER_OPTIONS", "MinerU Cloud modelVersion 必须是 pipeline 或 vlm");
  }
  if (protocol === "cloud-v4" && !CLOUD_LANGUAGES.has(language)) {
    throw new ParserError("INVALID_PARSER_OPTIONS", `MinerU Cloud 不支持语言：${language}`);
  }
  return {
    protocol,
    baseUrl,
    modelVersion,
    language,
    enableTable: booleanValue(input.enableTable, true),
    enableFormula: booleanValue(input.enableFormula, true),
    isOcr: booleanValue(input.isOcr, true),
    pollIntervalMs: boundedNumber(input.pollIntervalMs, 2_000, 250, 60_000),
    taskTimeoutMs: boundedNumber(input.taskTimeoutMs, 600_000, 10_000, 3_600_000)
  };
}

function resultToPayload(result: MinerUResult): ParsePayload {
  const title = result.markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return {
    schemaVersion: 2,
    markdown: result.markdown,
    metadata: title ? { title } : {},
    assets: result.assets,
    issues: result.issues
  };
}

function serializeResumeToken(task: MinerUTask): string {
  return JSON.stringify({ v: 2, protocol: task.protocol, id: task.id, fileName: task.fileName, dataId: task.dataId });
}

function parseResumeToken(token: string): MinerUTask {
  try {
    if (token.length > 4_096) throw new Error("too long");
    const value = JSON.parse(token) as Record<string, unknown>;
    if ((value.v !== 1 && value.v !== 2)
      || (value.protocol !== "cloud-v4" && value.protocol !== "self-hosted")
      || typeof value.id !== "string"
      || typeof value.fileName !== "string"
      || (value.v === 2 && value.dataId !== undefined && typeof value.dataId !== "string")) throw new Error("invalid");
    return {
      protocol: value.protocol,
      id: value.id,
      fileName: value.fileName,
      dataId: typeof value.dataId === "string" ? value.dataId : undefined
    };
  } catch {
    throw new ParserError("INVALID_RESUME_TOKEN", "MinerU resume token 无效");
  }
}

function parseMinerUResponse(response: HttpResponse): MinerUResult {
  if (isZip(response.bytes, response.headers["content-type"])) return parseMinerUArchive(response.bytes);
  const root = record(response.json);
  const markdown = findStringByKeys(root, ["markdown", "full_md", "md", "content"]);
  if (!markdown?.trim()) throw invalidResult("MinerU 结果不包含 Markdown");
  return { markdown, assets: [], issues: [] };
}

function parseMinerUArchive(bytes: Uint8Array): MinerUResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw new ParserError(
      "MINERU_RESULT_INVALID",
      `MinerU ZIP 无法解压：${error instanceof Error ? error.message : String(error)}`
    );
  }
  const names = Object.keys(files).sort();
  const markdownName = names.find((name) => /(?:^|\/)full\.md$/i.test(name));
  if (!markdownName) throw invalidResult("MinerU ZIP 中没有 full.md");
  let markdown = strFromU8(files[markdownName]!);
  const assets: ParsedAsset[] = [];
  const issues: ParseIssue[] = [];
  const imageNames = names.filter((name) => /\.(?:png|jpe?g|webp|gif|svg)$/i.test(name));
  for (const [index, name] of imageNames.entries()) {
    const assetId = `mineru-${String(index + 1).padStart(4, "0")}`;
    const mime = mimeForName(name);
    assets.push({ assetId, mime, bytes: files[name]!, source: {} });
    const candidates = [name, name.replace(/^.*?\//, ""), `./${name}`];
    for (const reference of candidates) {
      markdown = markdown.split(reference).join(`llm-wiki-asset:${assetId}`);
    }
  }
  const unsupported = names.filter((name) => /\.(?:bmp|tiff?|jp2)$/i.test(name));
  if (unsupported.length > 0) {
    issues.push({
      code: "MINERU_ASSET_UNSUPPORTED",
      severity: "warning",
      message: `${unsupported.length} 个 MinerU 图片资源格式暂未发布`
    });
  }
  return { markdown, assets, issues };
}

function buildMultipart(input: ParseInput, options: MinerUOptions): { contentType: string; body: Uint8Array } {
  const boundary = `----llm-wiki-${input.sourceHash.slice(0, 24)}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const field = (name: string, value: string): void => {
    chunks.push(encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  };
  field("return_md", "true");
  field("language", options.language);
  field("enable_table", String(options.enableTable));
  field("enable_formula", String(options.enableFormula));
  field("is_ocr", String(options.isOcr));
  chunks.push(encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${safeHeaderValue(input.name)}"\r\n`
    + `Content-Type: ${input.mime || "application/octet-stream"}\r\n\r\n`
  ));
  chunks.push(input.bytes);
  chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: concatBytes(chunks) };
}

function assertHttp(response: HttpResponse, code: string): void {
  if (response.status >= 200 && response.status < 300) return;
  const retryable = response.status === 429 || response.status >= 500 || response.status === 0;
  const message = sanitizeMessage(findStringByKeys(response.json, ["msg", "message", "detail", "error"])
    ?? `HTTP ${response.status}`);
  throw new ParserError(code, `MinerU 请求失败：${message}`, retryable, { status: response.status });
}

interface CloudEnvelope { code: string | number; data?: unknown; msg?: unknown; message?: unknown; trace_id?: unknown }

function cloudEnvelope(response: HttpResponse, code: string, allowError = false): CloudEnvelope {
  if (!response.json || typeof response.json !== "object" || Array.isArray(response.json)) {
    throw new ParserError(code, "MinerU Cloud 返回了无效的 JSON envelope", false);
  }
  const root = response.json as Record<string, unknown>;
  if (!("code" in root) || (typeof root.code !== "number" && typeof root.code !== "string")) {
    throw new ParserError(code, "MinerU Cloud 响应缺少有效的 code", false);
  }
  const envelope = root as unknown as CloudEnvelope;
  if (!allowError && normalizeApiCode(envelope.code) !== "0") throw cloudApiError(envelope, code);
  return envelope;
}

function normalizeApiCode(value: string | number): string {
  return String(value).trim();
}

function cloudApiError(envelope: CloudEnvelope, code: string): ParserError {
  const apiCode = normalizeApiCode(envelope.code);
  const retryableCodes = new Set(["-10001", "-60001", "-60007", "-60008", "-60009", "-60010", "-60020", "-60021", "-60022"]);
  const authentication = apiCode === "A0202" || apiCode === "A0211";
  const traceId = typeof envelope.trace_id === "string" ? sanitizeIdentifier(envelope.trace_id) : undefined;
  const rawMessage = taskMessage(envelope);
  const message = authentication ? "MinerU Cloud Token 无效或已过期" : sanitizeMessage(rawMessage);
  return new ParserError(code, `MinerU API 返回错误 [${apiCode}]：${message}`, retryableCodes.has(apiCode), {
    apiCode: envelope.code,
    ...(traceId ? { traceId } : {})
  });
}

async function uploadWithRetry(
  http: HttpClientPort,
  url: string,
  bytes: Uint8Array,
  initialDelayMs: number,
  signal?: AbortSignal
): Promise<void> {
  let lastError: ParserError | undefined;
  let delayMs = initialDelayMs;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    throwIfAborted(signal);
    let response: HttpResponse | undefined;
    try {
      response = await safeRequest(http, { url, method: "PUT", body: bytes }, "MINERU_UPLOAD_FAILED");
      assertHttp(response, "MINERU_UPLOAD_FAILED");
      return;
    } catch (error) {
      if (!(error instanceof ParserError) || !error.retryable) throw error;
      lastError = error;
      if (attempt < 3) {
        const waitMs = response ? retryDelay(response, delayMs) : delayMs;
        if (signal) await waitWithSignal(waitMs, signal);
        else await waitWithoutSignal(waitMs);
        delayMs = nextDelay(delayMs, initialDelayMs);
      }
    }
  }
  throw lastError ?? new ParserError("MINERU_UPLOAD_FAILED", "MinerU 签名上传失败", true);
}

async function safeRequest(
  http: HttpClientPort,
  request: Parameters<HttpClientPort["request"]>[0],
  code: string
): Promise<HttpResponse> {
  try {
    return await http.request(request);
  } catch (error) {
    if (error instanceof ParserError) throw error;
    throw new ParserError(
      code,
      `MinerU 网络请求失败：${sanitizeMessage(error instanceof Error ? error.message : String(error))}`,
      true
    );
  }
}

async function pollRequest(
  http: HttpClientPort,
  request: Parameters<HttpClientPort["request"]>[0],
  delayMs: number,
  context: ParseContext
): Promise<HttpResponse | undefined> {
  let response: HttpResponse;
  try {
    response = await safeRequest(http, request, "MINERU_POLL_FAILED");
  } catch (error) {
    if (!(error instanceof ParserError) || !error.retryable) throw error;
    await waitWithSignal(delayMs, context.signal);
    return undefined;
  }
  if (response.status === 429 || response.status >= 500 || response.status === 0) {
    await waitWithSignal(retryDelay(response, delayMs), context.signal);
    return undefined;
  }
  return response;
}

function firstTaskResult(input: unknown): Record<string, unknown> {
  const root = record(input);
  const data = record(root.data);
  for (const key of ["extract_result", "results", "tasks", "files"]) {
    const first = arrayValue(data[key])[0] ?? arrayValue(root[key])[0];
    if (first && typeof first === "object") return first as Record<string, unknown>;
  }
  return Object.keys(data).length > 0 ? data : root;
}

function matchingTaskResult(input: unknown, task: MinerUTask): Record<string, unknown> {
  const root = record(input);
  const candidates = arrayValue(root.extract_result)
    .concat(arrayValue(root.results), arrayValue(root.tasks), arrayValue(root.files))
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value));
  if (candidates.length === 0) return firstTaskResult(input);
  if (task.dataId) {
    const byDataId = candidates.find((item) => stringValue(item.data_id) === task.dataId);
    if (byDataId) return byDataId;
  }
  const byName = candidates.find((item) => {
    const name = stringValue(item.file_name) || stringValue(item.name);
    return name === task.fileName;
  });
  if (byName) return byName;
  if (candidates.length === 1) return candidates[0]!;
  throw invalidResult("MinerU Cloud 结果中找不到当前文件");
}

function taskState(input: unknown): string {
  return (findStringByKeys(input, ["state", "status", "task_status"]) ?? "").toLocaleLowerCase();
}

function reportMinerUProgress(context: ParseContext, input: unknown, state: string): void {
  const pageProgress = minerUPageProgress(input);
  if (pageProgress) {
    context.reportProgress({
      phase: "mineru-poll",
      completed: pageProgress.completed,
      total: pageProgress.total,
      unit: "page",
      message: `MinerU 已解析 ${pageProgress.completed}/${pageProgress.total} 页`
    });
    return;
  }
  const queuedAhead = numericValue(record(input).queued_ahead);
  context.reportProgress({
    phase: "mineru-poll",
    message: queuedAhead !== undefined && queuedAhead > 0
      ? `MinerU 排队中，前面还有 ${queuedAhead} 个任务`
      : minerUStateMessage(state)
  });
}

function minerUPageProgress(input: unknown): { completed: number; total: number } | undefined {
  const root = record(input);
  const candidates = [record(root.extract_progress), record(root.progress), root];
  for (const candidate of candidates) {
    const completed = firstNumeric(candidate, [
      "extracted_pages", "processed_pages", "completed_pages", "current_page"
    ]);
    const total = firstNumeric(candidate, ["total_pages", "page_count"]);
    if (completed !== undefined && total !== undefined && total > 0) {
      return { completed: Math.min(total, Math.max(0, completed)), total };
    }
  }
  return undefined;
}

function minerUStateMessage(state: string): string {
  switch (state) {
    case "waiting-file": return "MinerU 正在等待文件上传";
    case "pending": return "MinerU 任务排队中";
    case "running": return "MinerU 正在解析文档";
    case "converting": return "MinerU 正在生成 Markdown";
    case "done":
    case "completed":
    case "success": return "MinerU 解析完成";
    default: return `MinerU 状态：${state || "pending"}`;
  }
}

function firstNumeric(input: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numericValue(input[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function numericValue(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function taskMessage(input: unknown): string {
  return findStringByKeys(input, ["err_msg", "error", "message", "msg"]) ?? "MinerU 任务失败";
}

function findStringByKeys(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  for (const nested of Object.values(value)) {
    const candidate = Array.isArray(nested)
      ? nested.map((item) => findStringByKeys(item, keys)).find(Boolean)
      : findStringByKeys(nested, keys);
    if (candidate) return candidate;
  }
  return undefined;
}

function invalidResult(message: string): ParserError {
  return new ParserError("MINERU_RESULT_INVALID", message, false);
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : fallback;
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new ParserError("INVALID_PARSER_OPTIONS", `MinerU 数值配置必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return parsed;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function safeHeaderValue(value: string): string {
  return value.replace(/["\r\n]/g, "_");
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isZip(bytes: Uint8Array, contentType = ""): boolean {
  return /zip/i.test(contentType) || (bytes[0] === 0x50 && bytes[1] === 0x4b);
}

function mimeForName(name: string): string {
  const extension = name.split(".").pop()?.toLocaleLowerCase();
  const values: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml"
  };
  return values[extension ?? ""] ?? "application/octet-stream";
}

function retryDelay(response: HttpResponse, fallback: number): number {
  const raw = Object.entries(response.headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  const seconds = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  const date = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(date) ? Math.min(60_000, Math.max(0, date - Date.now())) : fallback;
}

function nextDelay(current: number, minimum: number): number {
  return Math.min(10_000, Math.max(minimum, Math.round(current * 1.5)));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 128);
}

function sanitizeMessage(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|key|signature|auth|credential)[^=]*)=[^&#\s]*/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/[^\s?#]+\?[^\s]*/gi, (url) => url.split("?")[0] + "?[REDACTED]")
    .slice(0, 1_000);
}

function waitWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new ParserError("PARSE_CANCELLED", "解析已取消", true));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new ParserError("PARSE_CANCELLED", "解析已取消", true));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function waitWithoutSignal(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
