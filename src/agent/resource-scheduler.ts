/**
 * Small, session-scoped scheduler for Agent tool calls.
 *
 * It deliberately models only safety-critical resources.  Read tools share a
 * read lock and can run together; mutation/terminal tools share a single
 * writer lock and therefore never overlap.  Tool-specific resources can be
 * supplied when a finer lock is useful.
 */
export type ResourceMode = "read" | "write";

export interface ToolResource {
  key: string;
  mode: ResourceMode;
}

export interface ScheduledTask<T> {
  id: string;
  resources: ToolResource[];
  run: () => Promise<T>;
}

export interface ScheduledTaskResult<T> {
  id: string;
  status: "fulfilled" | "rejected";
  value?: T;
  error?: unknown;
}

export class ResourceScheduler {
  constructor(
    private readonly options: { maxConcurrency?: number; maxReadConcurrency?: number } = {}
  ) {}

  run<T>(tasks: ScheduledTask<T>[], signal?: AbortSignal): Promise<ScheduledTaskResult<T>[]> {
    const maxConcurrency = Math.max(1, Math.floor(this.options.maxConcurrency ?? 4));
    const maxReadConcurrency = Math.max(1, Math.min(maxConcurrency,
      Math.floor(this.options.maxReadConcurrency ?? maxConcurrency)));
    const dependencies = buildDependencies(tasks);
    const results: Array<ScheduledTaskResult<T> | undefined> = new Array(tasks.length);
    const running = new Set<number>();
    const completed = new Set<number>();
    let readRunning = 0;
    let settled = false;
    let cancelled = false;
    let removeAbortListener: () => void = () => undefined;

    return new Promise((resolve) => {
      const finish = () => {
        if (settled || completed.size !== tasks.length) return;
        settled = true;
        removeAbortListener();
        resolve(results as ScheduledTaskResult<T>[]);
      };
      const cancelPending = () => {
        if (settled || cancelled) return;
        cancelled = true;
        const error = new Error("Agent 工具调度已取消");
        tasks.forEach((task, index) => {
          if (!completed.has(index) && !running.has(index)) {
            results[index] = { id: task.id, status: "rejected", error };
            completed.add(index);
          }
        });
        if (running.size === 0) finish();
      };
      const start = (index: number) => {
        running.add(index);
        if (isReadOnly(tasks[index]!.resources)) readRunning += 1;
        void tasks[index]!.run().then(
          (value) => { results[index] = { id: tasks[index]!.id, status: "fulfilled", value }; },
          (error) => { results[index] = { id: tasks[index]!.id, status: "rejected", error }; }
        ).finally(() => {
          running.delete(index);
          if (isReadOnly(tasks[index]!.resources)) readRunning -= 1;
          completed.add(index);
          pump();
        });
      };
      const pump = () => {
        if (signal?.aborted) cancelPending();
        if (cancelled) { finish(); return; }
        for (let index = 0; index < tasks.length && running.size < maxConcurrency; index += 1) {
          if (completed.has(index) || running.has(index) || !dependencies[index]!.every((dep) => completed.has(dep))) continue;
          const readOnly = isReadOnly(tasks[index]!.resources);
          if (readOnly && readRunning >= maxReadConcurrency) continue;
          if (tasks[index]!.resources.some((resource) => conflictsWithRunning(resource, tasks, running))) continue;
          start(index);
        }
        finish();
      };
      if (signal) {
        signal.addEventListener("abort", cancelPending, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", cancelPending);
      }
      pump();
    });
  }
}

export class InFlightTaskRegistry {
  private readonly tasks = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.tasks.get(key);
    if (existing) return existing as Promise<T>;
    const pending = task().finally(() => this.tasks.delete(key));
    this.tasks.set(key, pending);
    return pending;
  }

  clear(): void { this.tasks.clear(); }
}

export function defaultToolResources(read: boolean, parallelSafe: boolean): ToolResource[] {
  return read && parallelSafe
    ? [
      { key: "agent:execution", mode: "read" },
      { key: "agent:terminal", mode: "read" }
    ]
    : [{ key: "agent:execution", mode: "write" }];
}

function isReadOnly(resources: ToolResource[]): boolean {
  return resources.length > 0 && resources.every((resource) => resource.mode === "read");
}

function conflicts(left: ToolResource[], right: ToolResource[]): boolean {
  return left.some((a) => right.some((b) => a.key === b.key && (a.mode === "write" || b.mode === "write")));
}

function conflictsWithRunning<T>(resource: ToolResource, tasks: ScheduledTask<T>[], running: Set<number>): boolean {
  return [...running].some((index) => conflicts([resource], tasks[index]!.resources));
}

export function canonicalTaskKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTaskKey).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalTaskKey(item)}`).join(",")}}`;
}

function buildDependencies<T>(tasks: ScheduledTask<T>[]): number[][] {
  const dependencies = tasks.map(() => [] as number[]);
  for (let current = 0; current < tasks.length; current += 1) {
    for (let previous = 0; previous < current; previous += 1) {
      if (conflicts(tasks[previous]!.resources, tasks[current]!.resources)) dependencies[current]!.push(previous);
    }
  }
  return dependencies;
}
