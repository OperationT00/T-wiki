import type { App } from "obsidian";

interface SecretStorageLike {
  getSecret(id: string): string | null | undefined | Promise<string | null | undefined>;
  setSecret(id: string, value: string): void | Promise<void>;
}

export class SecretStore {
  private volatile = new Map<string, string>();
  private writes = new Map<string, Promise<void>>();

  constructor(private readonly app: App) {}

  async get(id: string): Promise<string> {
    if (!id) return "";
    await this.writes.get(id);
    const storage = this.secretStorage();
    if (storage) return String(await storage.getSecret(id) ?? "");
    return this.volatile.get(id) ?? "";
  }

  async set(id: string, value: string): Promise<void> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      const storage = this.secretStorage();
      if (storage) {
        await storage.setSecret(id, value);
        return;
      }
      this.volatile.set(id, value);
    });
    this.writes.set(id, write);
    try {
      await write;
    } finally {
      if (this.writes.get(id) === write) this.writes.delete(id);
    }
  }

  isPersistent(): boolean {
    return this.secretStorage() !== undefined;
  }

  private secretStorage(): SecretStorageLike | undefined {
    return (this.app as App & { secretStorage?: SecretStorageLike }).secretStorage;
  }
}
