import assert from "node:assert/strict";
import test from "node:test";

import {
  WebClipperInboxConnector,
  validateInboxPath
} from "../src/connectors/source-connector";
import { sha256 } from "../src/core/wiki-core";
import type { SourceManifest } from "../src/types";

test("Web Clipper connector scans a dedicated inbox and deduplicates through Intake", async () => {
  const bytes = new TextEncoder().encode("---\nsource: https://example.com\n---\n# Clipped\n");
  const vault = new FakeVault("Clippings/page.md", bytes);
  const seen = new Set<string>();
  const acquiredBy: string[] = [];
  const connector = new WebClipperInboxConnector(vault as any, {
    inboxPath: "Clippings",
    scanExistingOnStartup: false,
    settleDelayMs: 1,
    settleAttempts: 2
  });
  await connector.start({
    importSource: async (_name, input, provenance) => {
      const hash = sha256(input);
      const duplicate = seen.has(hash);
      seen.add(hash);
      acquiredBy.push(provenance.acquiredBy ?? "");
      return { manifest: manifest(hash), duplicate };
    }
  });
  const first = await connector.scan();
  const second = await connector.scan();
  await connector.stop();
  assert.deepEqual(first, { imported: 1, duplicates: 0, failed: [] });
  assert.deepEqual(second, { imported: 0, duplicates: 1, failed: [] });
  assert.deepEqual(acquiredBy, ["obsidian-web-clipper", "obsidian-web-clipper"]);
});

test("Web Clipper connector rejects system and parent directories", () => {
  for (const path of ["raw", "raw/clips", "wiki", ".llm-wiki/inbox", ".obsidian", "."]) {
    assert.throws(() => validateInboxPath(path, ".obsidian"));
  }
  assert.equal(validateInboxPath("Clippings/Web", ".obsidian"), "Clippings/Web");
});

class FakeVault {
  readonly configDir = ".obsidian";
  private readonly file: any;

  constructor(path: string, private readonly bytes: Uint8Array) {
    this.file = {
      path,
      name: path.split("/").at(-1),
      extension: "md",
      stat: { size: bytes.byteLength, mtime: 1, ctime: 1 }
    };
  }

  on(): any {
    return {};
  }

  offref(): void {}

  getAbstractFileByPath(path: string): any {
    if (path === this.file.path) return this.file;
    if (path === "Clippings") return { path, children: [this.file] };
    return null;
  }

  async readBinary(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(
      this.bytes.byteOffset,
      this.bytes.byteOffset + this.bytes.byteLength
    ) as ArrayBuffer;
  }
}

function manifest(sourceHash: string): SourceManifest {
  return {
    schemaVersion: 3,
    manifestRevision: 1,
    sourceId: "source-1",
    sourceHash,
    source: { kind: "web", acquiredBy: "obsidian-web-clipper" },
    original: {
      name: "page.md",
      extension: "md",
      mime: "text/markdown",
      size: 1,
      objectPath: ".llm-wiki/objects/test.md",
      importedAt: "2026-07-26T00:00:00.000Z"
    },
    parse: { status: "parsed", currentRevision: 1, revisions: [], attempts: [] },
    ingest: { status: "not_started", attempts: [] }
  };
}
