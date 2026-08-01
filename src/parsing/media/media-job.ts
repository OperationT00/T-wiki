import type { TimedTranscript } from "./transcript-types";

export interface MediaChunk {
  index: number;
  path: string;
  hash: string;
  startMs: number;
  endMs: number;
  overlapMs: number;
  size: number;
}

export interface MediaChunkState extends MediaChunk {
  status: "pending" | "completed" | "empty";
  resultPath?: string;
  resultHash?: string;
}

export interface MediaJobCheckpoint {
  version: 1;
  jobId: string;
  sourceId: string;
  sourceHash: string;
  parseKey: string;
  sourcePath: string;
  durationMs: number;
  chunks: MediaChunkState[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface MediaResumeToken {
  v: 1;
  jobId: string;
  sourceHash: string;
  parseKey: string;
  nextChunk: number;
}

export interface MediaJobStorePort {
  readonly available: boolean;
  createWorkspace(input: {
    sourceId: string;
    sourceHash: string;
    parseKey: string;
    extension: string;
    retentionHours: number;
    source: import("../parser-types").SourceBody;
    signal: AbortSignal;
  }): Promise<{ directory: string; sourcePath: string; jobId: string; createdAt: string; expiresAt: string }>;
  load(jobId: string): Promise<MediaJobCheckpoint>;
  save(checkpoint: MediaJobCheckpoint): Promise<void>;
  saveResult(jobId: string, index: number, transcript: TimedTranscript): Promise<string>;
  readResult(path: string): Promise<TimedTranscript>;
  cleanup(jobId: string): Promise<void>;
  cleanupSource(sourceId: string): Promise<void>;
  prune(now?: Date, validSources?: ReadonlyMap<string, string>): Promise<number>;
}
