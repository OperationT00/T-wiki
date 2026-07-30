export const PAGE_TYPES = ["source", "entity", "concept", "synthesis", "output"] as const;
export type WikiPageType = typeof PAGE_TYPES[number];
export type PageStatus = "stub" | "draft" | "reviewed";
export type ParseStatus = "queued" | "parsing" | "needs_ocr" | "parsed" | "parse_failed";
export type IngestStatus = "not_started" | "planning" | "awaiting_review" | "ingested" | "ingest_failed";
export type SourceKind = "markdown" | "text" | "pdf" | "web" | "audio" | "video" | "unknown";

export interface WikiConfig {
  schemaVersion: 4;
  name: string;
  domain: string;
  audience: string;
  language: string;
  paths: {
    raw: string;
    wiki: string;
    index: string;
    log: string;
    internal: string;
  };
  retrieval: {
    topK: number;
    maxPages: number;
  };
  parsing: {
    maxImportBytes: number;
    maxMediaImportBytes: number;
    maxOutputBytes: number;
    timeoutMs: number;
    providers: Record<string, ParserProviderConfig>;
  };
}

export interface ParserProviderConfig {
  enabled: boolean;
  priority: number;
  options: Record<string, unknown>;
}

/** v1-only state used by the explicit migration path. */
export interface RawRecord {
  path: string;
  hash: string;
  status: "pending" | "processing" | "ingested" | "failed";
  importedAt: string;
  sourcePage: string | null;
  error?: string;
  extractedPath?: string;
}

export interface WikiState {
  schemaVersion: 2;
  recentOperations: Array<{
    id: string;
    type: string;
    summary: string;
    at: string;
  }>;
}

export interface PipelineError {
  stage: "intake" | "parse" | "publish" | "ingest" | "plan" | "apply";
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, string | number | boolean>;
  at: string;
}

export interface SourceSpan {
  page?: number;
  block?: number;
  startLine?: number;
  endLine?: number;
  startMs?: number;
  endMs?: number;
  bbox?: [number, number, number, number];
  headingPath?: string[];
  selector?: string;
}

export interface ParseIssue {
  code: string;
  severity: "warning" | "error";
  message: string;
  source?: SourceSpan;
}

export interface ParseQuality {
  pageCount?: number;
  parsedPageCount?: number;
  ocrPageCount?: number;
  characterCount: number;
  blockCount: number;
  replacementCharacterRatio: number;
  emptyPageRatio?: number;
  veryLongLineCount: number;
  omittedImageCount: number;
  tableCount: number;
  overall: "pass" | "warning" | "fail";
}

export interface ParsedAsset {
  assetId: string;
  mime: string;
  bytes: Uint8Array;
  source: SourceSpan;
}

export interface SourceMetadata {
  title?: string;
  author?: string | string[];
  source?: string;
  url?: string;
  published?: string;
  created?: string;
  description?: string;
  tags?: string[];
  [key: string]: string | string[] | undefined;
}

export type SourceLocator =
  | { kind: "pdf"; page: number; bbox?: [number, number, number, number] }
  | { kind: "text"; startLine: number; endLine: number }
  | {
    kind: "web";
    url?: string;
    headingPath?: string[];
    selector?: string;
    ordinal?: number;
  };

export interface ProvenanceHint {
  output: { startLine: number; endLine: number };
  source: SourceLocator;
}

export interface ProviderStats {
  pageCount?: number;
  parsedPageCount?: number;
  ocrPageCount?: number;
  omittedImageCount?: number;
  tableCount?: number;
  [key: string]: number | undefined;
}

export interface ParsePayload {
  schemaVersion: 2;
  markdown: string;
  metadata: SourceMetadata;
  provenanceHints?: ProvenanceHint[];
  assets: ParsedAsset[];
  issues: ParseIssue[];
  stats?: ProviderStats;
}

export interface SourceMapEntry {
  blockId: string;
  type: "heading" | "paragraph" | "list" | "table" | "code" | "quote" | "html";
  raw: {
    startLine: number;
    endLine: number;
  };
  source: SourceLocator;
}

export interface DocumentSourceMap {
  schemaVersion: 1;
  sourceId: string;
  sourceHash: string;
  contentHash: string;
  entries: SourceMapEntry[];
}

export interface ParseProgress {
  phase: string;
  completed?: number;
  total?: number;
  unit?: "page" | "byte" | "document" | "item" | "second";
  percent?: number;
  mode?: "determinate" | "indeterminate";
  precision?: "exact" | "stage";
  message?: string;
  updatedAt?: string;
}

export interface ParseProgressEvent extends ParseProgress {
  sourceId: string;
  sourceName: string;
  attemptId: string;
  parserId: string;
  parserVersion: string;
  state: "running" | "completed" | "failed";
}

export interface ParseAttempt {
  attemptId: string;
  parseKey?: string;
  parserId?: string;
  parserVersion?: string;
  status: "parsing" | "parsed" | "needs_ocr" | "parse_failed";
  startedAt: string;
  completedAt?: string;
  progress?: ParseProgress;
  probeDiagnostics?: Array<{
    parserId: string;
    parserVersion: string;
    supported: boolean;
    confidence: number;
    reason?: string;
    error?: string;
  }>;
  resumeToken?: string;
  error?: PipelineError;
}

export interface ParseRevision {
  revision: number;
  parserId: string;
  parserVersion: string;
  parseKey: string;
  completedAt: string;
  rawPath: string;
  contentHash: string;
  artifactHash: string;
  artifactSchemaVersion: 1 | 2 | 3;
  sourceMapPath?: string;
  sourceMapHash?: string;
  assets?: PublishedAsset[];
  metadata: SourceMetadata;
  quality: ParseQuality;
  warnings: ParseIssue[];
}

export interface PublishedAsset {
  assetId: string;
  mime: string;
  path: string;
  hash: string;
  source?: SourceSpan;
}

export interface IngestAttempt {
  attemptId: string;
  revision: number;
  status: IngestStatus;
  startedAt: string;
  completedAt?: string;
  sourcePage?: string;
  operationId?: string;
  acceptedPaths: string[];
  coverage?: IngestCoverageReport;
  hasUserExclusions?: boolean;
  rolledBackAt?: string;
  rollbackOperationId?: string;
  error?: PipelineError;
}

export interface RollbackChange {
  path: string;
  originalAction: "create" | "update";
  rollbackAction: "delete" | "restore";
  before: string | null;
  afterHash: string;
}

export interface RollbackReceipt {
  version: 1;
  operationId: string;
  status: "applied" | "rolled_back";
  summary: string;
  appliedAt: string;
  sourceIds: string[];
  changes: RollbackChange[];
  rolledBackAt?: string;
  rollbackOperationId?: string;
}

export interface RollbackPreview {
  operationId: string;
  available: boolean;
  status?: RollbackReceipt["status"];
  summary?: string;
  appliedAt?: string;
  sourceIds: string[];
  changes: Array<Omit<RollbackChange, "before">>;
  conflicts: Array<{ path: string; reason: string }>;
  unavailableReason?: string;
}

export interface RollbackResult {
  operationId: string;
  rollbackOperationId: string;
  restoredPaths: string[];
  deletedPaths: string[];
  lintErrors: number;
}

export interface SourceDeletionPreview {
  sourceId: string;
  sourceName: string;
  wikiChanges: Array<{ path: string; action: "delete" | "restore" }>;
  dataPaths: string[];
  blockers: Array<{ path?: string; reason: string }>;
}

export interface SourceDeletionResult {
  sourceId: string;
  deletionOperationId: string;
  deletedDataPaths: string[];
  restoredWikiPaths: string[];
  deletedWikiPaths: string[];
}

export interface SourceManifest {
  schemaVersion: 3;
  manifestRevision: number;
  sourceId: string;
  sourceHash: string;
  source: {
    kind: SourceKind;
    uri?: string;
    requestedUri?: string;
    capturedAt?: string;
    acquiredBy: string;
    metadata?: SourceMetadata;
    capture?: {
      status?: number;
      contentType?: string;
      etag?: string;
      lastModified?: string;
      platform?: "bilibili" | "douyin";
      videoId?: string;
      durationMs?: number;
    };
  };
  original: {
    name: string;
    extension: string;
    mime: string;
    size: number;
    objectPath: string;
    importedAt: string;
  };
  parse: {
    status: ParseStatus;
    currentRevision?: number;
    startedAt?: string;
    revisions: ParseRevision[];
    attempts: ParseAttempt[];
    error?: PipelineError;
  };
  ingest: {
    status: IngestStatus;
    revision?: number;
    attempts: IngestAttempt[];
  };
}

export interface IngestInput {
  sourceId: string;
  revision: number;
  rawPath: string;
  sourceHash: string;
  contentHash: string;
  artifactHash: string;
  parserId: string;
  parserVersion: string;
  parseWarnings: ParseIssue[];
  metadata: SourceMetadata;
}

export interface RawVerification {
  sourceId: string;
  ok: boolean;
  issues: ParseIssue[];
}

export interface WikiPage {
  path: string;
  basename: string;
  type: WikiPageType;
  title: string;
  tldr: string;
  status: PageStatus;
  created: string;
  updated: string;
  tags: string[];
  related: string[];
  aliases: string[];
  frontmatter: Record<string, unknown>;
  body: string;
  content: string;
  links: string[];
}

export type LintSeverity = "error" | "warning" | "info";
export interface LintIssue {
  code: string;
  severity: LintSeverity;
  path: string;
  message: string;
  fixable?: boolean;
}

export interface LintReport {
  generatedAt: string;
  issues: LintIssue[];
  pageCount: number;
}

export interface SearchResult {
  page: WikiPage;
  score: number;
  reasons: string[];
}

export interface ChangeOperation {
  action: "create" | "update";
  path: string;
  expectedHash?: string;
  content: string;
  reason: string;
}

export interface EvidenceReference {
  sourceId?: string;
  contentHash?: string;
  sectionId?: string;
  wikiPath?: string;
  wikiHash?: string;
}

export type KnowledgeDecisionStatus =
  | "created"
  | "updated"
  | "already_covered"
  | "source_only"
  | "insufficient_evidence"
  | "user_rejected";

export interface KnowledgeDecision {
  candidateId: string;
  sourceId: string;
  type: "entity" | "concept" | "synthesis";
  title: string;
  decision: KnowledgeDecisionStatus;
  targetPath?: string;
  reason: string;
  evidence: EvidenceReference[];
}

export interface IngestCoverageReport {
  sources: Array<{
    sourceId: string;
    contentHash: string;
    reviewedSectionIds: string[];
    noReusableKnowledgeReason?: string;
  }>;
  categoryAssessments: Array<{
    sourceId: string;
    type: "entity" | "concept" | "synthesis";
    outcome: "candidates_found" | "none";
    reason: string;
  }>;
  decisions: KnowledgeDecision[];
}

export interface WikiChangePlan {
  version: 1;
  operationId: string;
  summary: string;
  operations: ChangeOperation[];
  ingestCoverage?: IngestCoverageReport;
}

export interface ModelProfile {
  id: string;
  label: string;
  contextWindow: number;
  role: "fast" | "default" | "deep";
}

export type LlmProtocol = "openai-chat-completions" | "anthropic-messages";
export type StructuredOutputMode = "auto" | "native" | "prompt";
export type AgentPurpose =
  | "ingest-plan"
  | "chunk-summary"
  | "query"
  | "chat"
  | "save-plan"
  | "connection-test"
  | "agent-ingest"
  | "agent-query"
  | "agent-chat"
  | "agent-save"
  | "agent-lint";
export type AgentErrorCode =
  | "AUTHENTICATION"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "CONTEXT_LENGTH_EXCEEDED"
  | "CONTEXT_CAPACITY_EXCEEDED"
  | "AGENT_TOOL_RETRY_LOOP"
  | "OUTPUT_TRUNCATED"
  | "SCHEMA_UNSUPPORTED"
  | "INVALID_STRUCTURED_OUTPUT"
  | "PROVIDER_UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "REFUSAL"
  | "INVALID_CONFIG"
  | "UNKNOWN";

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

export interface LlmProviderConfig {
  protocol: LlmProtocol;
  baseUrl: string;
  token: string;
  structuredOutputMode: StructuredOutputMode;
  timeoutMs: number;
  maxRetries: number;
}

export interface AgentConfig {
  provider: LlmProviderConfig;
  models: ModelProfile[];
}

export type AgentToolRisk = "read" | "stage" | "terminal" | "interaction";

export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  strict?: boolean;
}

export type AgentConversationContent =
  | { type: "text"; text: string }
  | {
      type: "reasoning";
      provider: LlmProtocol;
      text: string;
      signature?: string;
    }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; output: unknown; isError: boolean };

export interface AgentConversationMessage {
  role: "user" | "assistant";
  content: AgentConversationContent[];
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface AgentTurnRequest {
  modelRole?: ModelProfile["role"];
  systemPrompt: string;
  messages: AgentConversationMessage[];
  tools: LlmToolDefinition[];
  toolChoice: "auto" | "required" | "none";
  maxOutputTokens: number;
}

export interface AgentTurnResult {
  text: string;
  reasoning?: Extract<AgentConversationContent, { type: "reasoning" }>[];
  toolCalls: AgentToolCall[];
  provider: LlmProtocol;
  model: string;
  requestId?: string;
  usage?: AgentUsage;
  finishReason?: string;
}

export interface AgentBudget {
  maxIterations: number;
  maxToolCalls: number;
  maxChangedPages: number;
  maxWallTimeMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolResultTokens: number;
}

export type AgentPhase =
  | "source_understanding"
  | "knowledge_comparison"
  | "researching"
  | "answering"
  | "staging"
  | "validating"
  | "submitting";

export interface ContextCheckpoint {
  version: 1;
  phase: AgentPhase;
  completedActions: string[];
  keyFindings: Array<{ statement: string; evidence: EvidenceReference[] }>;
  unresolved: string[];
  nextActions: string[];
}

export interface ContextUsage {
  liveContextTokens: number;
  maxContextTokens: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cachedInputTokens: number;
  cacheHits: number;
  checkpointCount: number;
  compactedTokens: number;
  breakdown: {
    system: number;
    tools: number;
    messages: number;
    raw: number;
    wiki: number;
    workingSet: number;
  };
}

export type AgentBudgetName = "chat" | "query" | "queryDeep" | "ingest" | "ingestBatch" | "save" | "lintFix";

export interface SessionOptions {
  modelRole?: ModelProfile["role"];
  systemPrompt?: string;
  outputSchema?: Record<string, unknown>;
  purpose?: AgentPurpose;
  maxOutputTokens?: number;
}

export interface AgentSession {
  id: string;
}

export interface AgentMessage {
  content: string;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "status"; message: string }
  | { type: "iteration"; iteration: number; maxIterations: number }
  | { type: "tool_started"; toolCallId: string; name: string }
  | { type: "tool_completed"; toolCallId: string; name: string; isError: boolean; summary: string }
  | { type: "waiting_user"; discoveries: string; questions: string[] }
  | { type: "budget"; iterations: number; toolCalls: number; elapsedMs: number; context?: ContextUsage }
  | { type: "plan_ready"; operationId: string; changedPaths: string[] }
  | {
    type: "result";
    sessionId?: string;
    provider: LlmProtocol;
    model: string;
    requestId?: string;
    usage?: AgentUsage;
    structuredOutput?: unknown;
  }
  | { type: "error"; code: AgentErrorCode; error: string; retryable: boolean };

export type IngestProgressState = "running" | "awaiting_review" | "completed" | "failed" | "cancelled";
export type IngestProgressPhase =
  | "preparing"
  | "reading_source"
  | "retrieving_wiki"
  | "drafting"
  | "validating"
  | "submitting";

export interface IngestActivity {
  id: string;
  toolCallId: string;
  name: string;
  label: string;
  status: "running" | "completed" | "failed";
  summary?: string;
  startedAt: string;
  completedAt?: string;
}

export interface IngestProgressSnapshot {
  runId: string;
  sourceIds: string[];
  state: IngestProgressState;
  phase: IngestProgressPhase;
  message: string;
  iteration: number;
  maxIterations: number;
  toolCalls: number;
  maxToolCalls: number;
  elapsedMs: number;
  context?: ContextUsage;
  startedAt: string;
  updatedAt: string;
  activities: IngestActivity[];
}

export interface AgentRuntime {
  initialize(config: AgentConfig): Promise<void>;
  startSession(options: SessionOptions): Promise<AgentSession>;
  send(message: AgentMessage): AsyncIterable<AgentEvent>;
  runTurn?(request: AgentTurnRequest, sink?: (event: AgentEvent) => void): Promise<AgentTurnResult>;
  testConnection(): Promise<string>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PluginSettings {
  schemaVersion: 6;
  agent: {
    protocol: LlmProtocol;
    baseUrl: string;
    secretId: string;
    structuredOutputMode: StructuredOutputMode;
    timeoutMs: number;
    maxRetries: number;
    toolCallingRequired: boolean;
    budgets: Record<AgentBudgetName, AgentBudget>;
    models: ModelProfile[];
  };
  activeTab: "home" | "materials" | "agent" | "review" | "query";
  sessions: ChatSession[];
  activeSessionId: string;
  webClipper: {
    enabled: boolean;
    inboxPath: string;
    scanExistingOnStartup: boolean;
  };
  onlineVideo: {
    douyin: {
      enabled: boolean;
      ytDlpPath: string;
      maxDownloadBytes: number;
      taskTimeoutMs: number;
      cookieBrowser: "edge" | "chrome" | "firefox";
    };
  };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  runtimeSessionId?: string;
  messages: ChatMessage[];
}
