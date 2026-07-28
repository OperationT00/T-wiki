import { ParserRegistry } from "./parser-registry";
import { MarkdownParser } from "./parsers/markdown-parser";
import { MinerUParser, type MinerUCredentials } from "./parsers/mineru-parser";
import { PdfParser } from "./parsers/pdf-parser";
import { TextParser } from "./parsers/text-parser";
import { WebPageParser } from "./parsers/webpage-parser";
import type { HttpClientPort } from "./http-client";

/** Composition root for built-in parsers. */
export function createDefaultParserRegistry(dependencies: {
  mineru?: { http: HttpClientPort; credentials: MinerUCredentials };
} = {}): ParserRegistry {
  const registry = new ParserRegistry()
    .register(new PdfParser())
    .register(new MarkdownParser())
    .register(new TextParser())
    .register(new WebPageParser());
  if (dependencies.mineru) {
    registry.register(new MinerUParser(
      dependencies.mineru.http,
      dependencies.mineru.credentials
    ));
  }
  return registry;
}
