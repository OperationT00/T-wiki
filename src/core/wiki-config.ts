import type { ParserProviderConfig, WikiConfig } from "../types";
import { DEFAULT_CONFIG } from "./wiki-core";

export function mergeConfig(input: Partial<WikiConfig>): WikiConfig {
  const inputRecord = input as unknown as Record<string, unknown>;
  const legacyParsing = asRecord(inputRecord.parsing);
  const legacyPdf = asRecord(legacyParsing.pdf);
  const providerInput = asRecord(legacyParsing.providers);
  const defaultProviders = DEFAULT_CONFIG.parsing.providers;
  const providers: Record<string, ParserProviderConfig> = {};
  const providerIds = new Set([...Object.keys(defaultProviders), ...Object.keys(providerInput)]);
  for (const id of providerIds) {
    const defaults = defaultProviders[id] ?? { enabled: true, priority: 0, options: {} };
    const candidate = asRecord(providerInput[id]);
    providers[id] = {
      enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : defaults.enabled,
      priority: finiteNumber(candidate.priority) ?? defaults.priority,
      options: { ...defaults.options, ...asRecord(candidate.options) }
    };
  }
  if (!("providers" in legacyParsing) && Object.keys(legacyPdf).length > 0) {
    const pdfProvider = providers["pdfjs-layout"] ?? DEFAULT_CONFIG.parsing.providers["pdfjs-layout"]!;
    providers["pdfjs-layout"] = {
      ...pdfProvider,
      options: {
        ...pdfProvider.options,
        maxPdfPages: finiteNumber(legacyParsing.maxPdfPages) ?? 1000,
        maxPdfTextItems: finiteNumber(legacyParsing.maxPdfTextItems) ?? 2_000_000,
        ...legacyPdf
      }
    };
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    assertNoProviderSecrets(providerId, provider.options);
  }
  return {
    ...DEFAULT_CONFIG,
    ...input,
    schemaVersion: 4,
    paths: { ...DEFAULT_CONFIG.paths, ...(input.paths ?? {}) },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...(input.retrieval ?? {}) },
    parsing: {
      maxImportBytes: finiteNumber(legacyParsing.maxImportBytes) ?? DEFAULT_CONFIG.parsing.maxImportBytes,
      maxMediaImportBytes: finiteNumber(legacyParsing.maxMediaImportBytes)
        ?? DEFAULT_CONFIG.parsing.maxMediaImportBytes,
      maxOutputBytes: finiteNumber(legacyParsing.maxOutputBytes) ?? DEFAULT_CONFIG.parsing.maxOutputBytes,
      timeoutMs: finiteNumber(legacyParsing.timeoutMs) ?? DEFAULT_CONFIG.parsing.timeoutMs,
      providers
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function assertNoProviderSecrets(providerId: string, options: Record<string, unknown>): void {
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = `${path}.${key}`;
      if (/(?:token|secret|password|api[_-]?key|authorization)/i.test(key)) {
        throw new Error(`Parser Provider ${providerId} 的密钥不能写入配置：${nextPath}`);
      }
      visit(nested, nextPath);
    }
  };
  visit(options, "options");
}
