import type { AgentBudget, AgentBudgetName, ModelProfile, PluginSettings } from "../types";

const BASE_BUDGET = {
  maxWallTimeMs: 3_600_000,
  maxInputTokens: 4_000_000,
  maxOutputTokens: 256_000,
  maxToolResultTokens: 64_000
} as const;

export const DEFAULT_AGENT_BUDGETS: Record<AgentBudgetName, AgentBudget> = {
  chat: { ...BASE_BUDGET, maxIterations: 32, maxToolCalls: 80, maxChangedPages: 0, maxOutputTokens: 64_000 },
  query: { ...BASE_BUDGET, maxIterations: 48, maxToolCalls: 140, maxChangedPages: 0, maxOutputTokens: 96_000 },
  queryDeep: { ...BASE_BUDGET, maxIterations: 96, maxToolCalls: 300, maxChangedPages: 0, maxOutputTokens: 192_000 },
  ingest: { ...BASE_BUDGET, maxIterations: 120, maxToolCalls: 400, maxChangedPages: 100 },
  ingestBatch: { ...BASE_BUDGET, maxIterations: 200, maxToolCalls: 800, maxChangedPages: 200 },
  save: { ...BASE_BUDGET, maxIterations: 64, maxToolCalls: 200, maxChangedPages: 50 },
  lintFix: { ...BASE_BUDGET, maxIterations: 96, maxToolCalls: 320, maxChangedPages: 150 }
};

export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  schemaVersion: 5,
  agent: {
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    secretId: "t-wiki-agent-api-token",
    structuredOutputMode: "auto",
    timeoutMs: 300_000,
    maxRetries: 2,
    toolCallingRequired: true,
    budgets: structuredClone(DEFAULT_AGENT_BUDGETS),
    models: [
      { id: "claude-haiku-4-5", label: "Fast", contextWindow: 200000, role: "fast" },
      { id: "claude-sonnet-4-6", label: "Default", contextWindow: 200000, role: "default" },
      { id: "claude-opus-4-6", label: "Deep", contextWindow: 200000, role: "deep" }
    ]
  },
  activeTab: "home",
  sessions: [],
  activeSessionId: "",
  webClipper: {
    enabled: false,
    inboxPath: "Clippings",
    scanExistingOnStartup: false
  }
};

export type StoredPluginSettings = Partial<PluginSettings> & {
  cliPath?: string;
  baseUrl?: string;
  secretId?: string;
  models?: ModelProfile[];
  loadUserSettings?: boolean;
};

export function normalizePluginSettings(data: StoredPluginSettings | null | undefined): PluginSettings {
  const defaults = structuredClone(DEFAULT_PLUGIN_SETTINGS);
  const agentInput = data?.agent && typeof data.agent === "object" ? data.agent : undefined;
  const legacy = !agentInput;
  const legacyModels = Array.isArray(data?.models) ? data.models : undefined;
  const protocol = agentInput?.protocol === "openai-chat-completions"
    ? "openai-chat-completions"
    : "anthropic-messages";
  return {
    schemaVersion: 5,
    agent: {
      ...defaults.agent,
      ...(agentInput ?? {}),
      protocol,
      baseUrl: String(agentInput?.baseUrl ?? (legacy ? data?.baseUrl : "") ?? defaults.agent.baseUrl).trim()
        || defaults.agent.baseUrl,
      secretId: String(agentInput?.secretId ?? (legacy ? data?.secretId : "") ?? defaults.agent.secretId).trim()
        || defaults.agent.secretId,
      structuredOutputMode: agentInput?.structuredOutputMode === "native" || agentInput?.structuredOutputMode === "prompt"
        ? agentInput.structuredOutputMode
        : "auto",
      timeoutMs: normalizeInteger(agentInput?.timeoutMs, 1_000, 600_000, defaults.agent.timeoutMs),
      maxRetries: normalizeInteger(agentInput?.maxRetries, 0, 5, defaults.agent.maxRetries),
      toolCallingRequired: true,
      budgets: normalizeBudgets(agentInput?.budgets, Number(data?.schemaVersion) < 5),
      models: normalizeModels(agentInput?.models ?? legacyModels)
    },
    activeTab: ["home", "materials", "agent", "review", "query"].includes(String(data?.activeTab))
      ? data!.activeTab!
      : defaults.activeTab,
    sessions: Array.isArray(data?.sessions) ? data.sessions.slice(0, 20) : [],
    activeSessionId: typeof data?.activeSessionId === "string" ? data.activeSessionId : "",
    webClipper: {
      ...defaults.webClipper,
      ...(data?.webClipper && typeof data.webClipper === "object" ? data.webClipper : {})
    }
  };
}

function normalizeBudgets(
  input: Partial<Record<AgentBudgetName, Partial<AgentBudget>>> | undefined,
  migrateLegacyDefaults = false
): Record<AgentBudgetName, AgentBudget> {
  const result = structuredClone(DEFAULT_AGENT_BUDGETS);
  for (const name of Object.keys(result) as AgentBudgetName[]) {
    const value = input?.[name];
    if (!value) continue;
    const fallback = result[name];
    const old = legacyBudgetDefaults(name);
    result[name] = {
      maxIterations: migrateValue(value.maxIterations, old.maxIterations, fallback.maxIterations, migrateLegacyDefaults, 1, 500),
      maxToolCalls: migrateValue(value.maxToolCalls, old.maxToolCalls, fallback.maxToolCalls, migrateLegacyDefaults, 1, 2_000),
      maxChangedPages: migrateValue(value.maxChangedPages, old.maxChangedPages, fallback.maxChangedPages, migrateLegacyDefaults, 0, 500),
      maxWallTimeMs: migrateValue(value.maxWallTimeMs, [600_000], fallback.maxWallTimeMs, migrateLegacyDefaults, 10_000, 21_600_000),
      maxInputTokens: migrateValue(value.maxInputTokens, [120_000], fallback.maxInputTokens, migrateLegacyDefaults, 1_000, 20_000_000),
      maxOutputTokens: migrateValue(value.maxOutputTokens, old.maxOutputTokens, fallback.maxOutputTokens, migrateLegacyDefaults, 256, 2_000_000),
      maxToolResultTokens: migrateValue(value.maxToolResultTokens, [12_000], fallback.maxToolResultTokens, migrateLegacyDefaults, 256, 250_000)
    };
  }
  return result;
}

function legacyBudgetDefaults(name: AgentBudgetName): {
  maxIterations: number[];
  maxToolCalls: number[];
  maxChangedPages: number[];
  maxOutputTokens: number[];
} {
  const values: Record<AgentBudgetName, [number[], number[], number[], number[]]> = {
    chat: [[8], [16], [0], [4_096]],
    query: [[10], [24], [0], [4_096]],
    queryDeep: [[18], [40], [0], [4_096]],
    ingest: [[20, 28], [40, 64], [12, 20], [16_384]],
    ingestBatch: [[28, 36], [64, 96], [20, 30], [16_384]],
    save: [[15], [30], [6], [16_384]],
    lintFix: [[20], [40], [20], [16_384]]
  };
  const [maxIterations, maxToolCalls, maxChangedPages, maxOutputTokens] = values[name];
  return { maxIterations, maxToolCalls, maxChangedPages, maxOutputTokens };
}

function migrateValue(
  value: unknown,
  legacyDefaults: number[],
  fallback: number,
  migrate: boolean,
  min: number,
  max: number
): number {
  if (migrate && legacyDefaults.includes(Number(value))) return fallback;
  return normalizeInteger(value, min, max, fallback);
}

function normalizeModels(models: ModelProfile[] | undefined): ModelProfile[] {
  const defaults = structuredClone(DEFAULT_PLUGIN_SETTINGS.agent.models);
  if (!Array.isArray(models)) return defaults;
  return (["fast", "default", "deep"] as const).map((role) => {
    const value = models.find((item) => item.role === role);
    return value?.id?.trim() && Number.isFinite(value.contextWindow) && value.contextWindow > 0
      ? { ...value, id: value.id.trim(), label: value.label?.trim() || value.id.trim() }
      : defaults.find((item) => item.role === role)!;
  });
}

function normalizeInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;
}
