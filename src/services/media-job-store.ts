import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { MediaJobCheckpoint, MediaJobStorePort } from "../parsing/media/media-job";
import type { TimedTranscript } from "../parsing/media/transcript-types";
import { ParserError, throwIfAborted } from "../parsing/parser-types";

export class FileSystemMediaJobStore implements MediaJobStorePort {
  readonly available = true;
  constructor(private readonly root: string) {}

  async createWorkspace(input: Parameters<MediaJobStorePort["createWorkspace"]>[0]) {
    const jobId = createHash("sha256")
      .update(`${input.sourceHash}\0${input.parseKey}`)
      .digest("hex")
      .slice(0, 32);
    const directory = this.jobDirectory(jobId);
    await mkdir(directory, { recursive: true });
    const safeExtension = input.extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "media";
    const sourcePath = join(directory, `source.${safeExtension}`);
    const sourceExists = await stat(sourcePath).then(() => true, () => false);
    if (sourceExists) {
      if (await hashFile(sourcePath) !== input.sourceHash) {
        await rm(directory, { recursive: true, force: true });
        throw new ParserError("SOURCE_HASH_MISMATCH", "媒体任务缓存中的原件 Hash 不一致");
      }
    } else {
      const temporary = `${sourcePath}.tmp`;
      const writer = createWriteStream(temporary, { flags: "wx" });
      const hash = createHash("sha256");
      try {
        for await (const chunk of input.source.openStream()) {
          throwIfAborted(input.signal);
          hash.update(chunk);
          if (!writer.write(chunk)) await new Promise<void>((resolvePromise, reject) => {
            writer.once("drain", resolvePromise);
            writer.once("error", reject);
          });
        }
        await new Promise<void>((resolvePromise, reject) => {
          writer.once("error", reject);
          writer.end(resolvePromise);
        });
        if (hash.digest("hex") !== input.sourceHash) throw new ParserError("SOURCE_HASH_MISMATCH", "媒体任务原件 Hash 不一致");
        await import("node:fs/promises").then(({ rename }) => rename(temporary, sourcePath));
      } catch (error) {
        writer.destroy();
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + input.retentionHours * 3_600_000).toISOString();
    await writeFile(join(directory, "workspace.json"), `${JSON.stringify({
      version: 1,
      sourceId: input.sourceId,
      sourceHash: input.sourceHash,
      expiresAt
    })}\n`, "utf8");
    return { directory, sourcePath, jobId, createdAt, expiresAt };
  }

  async load(jobId: string): Promise<MediaJobCheckpoint> {
    const path = this.safePath(join(this.jobDirectory(jobId), "job.json"));
    await recoverAtomicFile(path);
    const value = JSON.parse(await readFile(path, "utf8")) as MediaJobCheckpoint;
    if (value.version !== 1 || value.jobId !== jobId || !Array.isArray(value.chunks)) {
      throw new ParserError("TRANSCRIPTION_RESUME_INVALID", "媒体断点任务格式无效");
    }
    return value;
  }

  async save(checkpoint: MediaJobCheckpoint): Promise<void> {
    checkpoint.updatedAt = new Date().toISOString();
    const path = this.safePath(join(this.jobDirectory(checkpoint.jobId), "job.json"));
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    await replaceAtomicFile(temporary, path);
  }

  async saveResult(jobId: string, index: number, transcript: TimedTranscript): Promise<string> {
    const path = this.safePath(join(this.jobDirectory(jobId), "results", `chunk-${String(index).padStart(5, "0")}.json`));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(transcript)}\n`, "utf8");
    return path;
  }

  async readResult(path: string): Promise<TimedTranscript> {
    return JSON.parse(await readFile(this.safePath(path), "utf8")) as TimedTranscript;
  }

  async cleanup(jobId: string): Promise<void> {
    await rm(this.jobDirectory(jobId), { recursive: true, force: true });
  }

  async cleanupSource(sourceId: string): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const checkpoint = await this.load(entry.name);
        if (checkpoint.sourceId === sourceId) await this.cleanup(entry.name);
      } catch {
        try {
          const workspace = JSON.parse(await readFile(join(this.root, entry.name, "workspace.json"), "utf8")) as { sourceId?: string };
          if (workspace.sourceId === sourceId) await this.cleanup(entry.name);
        } catch {
          // Expired or unidentifiable workspaces are handled by prune.
        }
      }
    }
  }

  async prune(now = new Date(), validSources?: ReadonlyMap<string, string>): Promise<number> {
    await mkdir(this.root, { recursive: true });
    let removed = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const checkpoint = await this.load(entry.name);
        const expectedHash = validSources?.get(checkpoint.sourceId);
        const invalidSource = validSources !== undefined
          && (expectedHash === undefined || expectedHash !== checkpoint.sourceHash);
        if (!invalidSource && Date.parse(checkpoint.expiresAt) > now.getTime()) continue;
      } catch {
        // Incomplete workspaces older than a day are removed below.
        const info = await stat(join(this.root, entry.name));
        if (now.getTime() - info.mtimeMs < 86_400_000) continue;
      }
      await this.cleanup(entry.name);
      removed += 1;
    }
    return removed;
  }

  private jobDirectory(jobId: string): string {
    if (!/^[a-f0-9]{32}$/i.test(jobId)) throw new ParserError("TRANSCRIPTION_RESUME_INVALID", "媒体任务 ID 无效");
    return this.safePath(join(this.root, jobId));
  }

  private safePath(path: string): string {
    const root = `${resolve(this.root)}${sep}`.toLowerCase();
    const absolute = resolve(path);
    if (!`${absolute}${sep}`.toLowerCase().startsWith(root)) throw new Error("MEDIA_JOB_PATH_OUTSIDE_ROOT");
    return absolute;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function recoverAtomicFile(path: string): Promise<void> {
  const backup = `${path}.bak`;
  const currentExists = await stat(path).then(() => true, () => false);
  const backupExists = await stat(backup).then(() => true, () => false);
  if (!currentExists && backupExists) await rename(backup, path);
  else if (currentExists && backupExists) await rm(backup, { force: true });
  await rm(`${path}.tmp`, { force: true });
}

async function replaceAtomicFile(temporary: string, path: string): Promise<void> {
  const backup = `${path}.bak`;
  await rm(backup, { force: true });
  const currentExists = await stat(path).then(() => true, () => false);
  if (currentExists) await rename(path, backup);
  try {
    await rename(temporary, path);
    await rm(backup, { force: true });
  } catch (error) {
    if (currentExists && await stat(backup).then(() => true, () => false)) {
      await rename(backup, path);
    }
    await rm(temporary, { force: true });
    throw error;
  }
}
