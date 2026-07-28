import type { WikiConfig } from "../types";
import { DEFAULT_CONFIG } from "./wiki-core";

export function mergeConfig(input: Partial<WikiConfig>): WikiConfig {
  const legacyParsing = (input as any).parsing ?? {};
  const legacyPdf = legacyParsing.pdf ?? {};
  const providerInput = legacyParsing.providers ?? {};
  const defaultProviders = DEFAULT_CONFIG.parsing.providers;
  const providers = Object.fromEntries(
    Object.entries({ ...defaultProviders, ...providerInput }).map(([id, value]) => {
      const defaults = defaultProviders[id] ?? { enabled: true, priority: 0, options: {} };
      const candidate = (value ?? {}) as Partial<typeof defaults>;
      return [id, {
        ...defaults,
        ...candidate,
        options: { ...defaults.options, ...(candidate.options ?? {}) }
      }];
    })
  );
  if (!legacyParsing.providers && Object.keys(legacyPdf).length > 0) {
    const pdfProvider = providers["pdfjs-layout"] ?? DEFAULT_CONFIG.parsing.providers["pdfjs-layout"]!;
    providers["pdfjs-layout"] = {
      ...pdfProvider,
      options: {
        ...pdfProvider.options,
        maxPdfPages: legacyParsing.maxPdfPages ?? 1000,
        maxPdfTextItems: legacyParsing.maxPdfTextItems ?? 2_000_000,
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
    schemaVersion: 3,
    paths: { ...DEFAULT_CONFIG.paths, ...(input.paths ?? {}) },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...(input.retrieval ?? {}) },
    parsing: {
      maxImportBytes: legacyParsing.maxImportBytes ?? DEFAULT_CONFIG.parsing.maxImportBytes,
      maxOutputBytes: legacyParsing.maxOutputBytes ?? DEFAULT_CONFIG.parsing.maxOutputBytes,
      timeoutMs: legacyParsing.timeoutMs ?? DEFAULT_CONFIG.parsing.timeoutMs,
      providers
    }
  };
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
