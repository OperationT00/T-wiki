interface QueuedTask<T> {
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

export class AsyncTaskPool {
  private active = 0;
  private disposed = false;
  private readonly queue: QueuedTask<unknown>[] = [];

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("AsyncTaskPool concurrency must be a positive integer");
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("AsyncTaskPool has been disposed"));
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const queued: QueuedTask<T> = { run: task, resolve, reject, signal };
      if (signal) {
        queued.abort = () => {
          const index = this.queue.indexOf(queued as QueuedTask<unknown>);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", queued.abort, { once: true });
      }
      this.queue.push(queued as QueuedTask<unknown>);
      this.drain();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const task of this.queue.splice(0)) {
      if (task.abort && task.signal) task.signal.removeEventListener("abort", task.abort);
      task.reject(new Error("AsyncTaskPool has been disposed"));
    }
  }

  private drain(): void {
    while (!this.disposed && this.active < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      if (task.abort && task.signal) task.signal.removeEventListener("abort", task.abort);
      if (task.signal?.aborted) {
        task.reject(abortError());
        continue;
      }
      this.active += 1;
      void task.run().then(task.resolve, task.reject).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }
}

function abortError(): Error {
  const error = new Error("Task was cancelled while waiting for a parsing slot");
  error.name = "AbortError";
  return error;
}
