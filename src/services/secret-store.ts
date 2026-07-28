import type { App } from "obsidian";

export class SecretStore {
  private volatile = new Map<string, string>();
  private writes = new Map<string, Promise<void>>();

  constructor(private readonly app: App) {}

  async get(id: string): Promise<string> {
    if (!id) return "";
    await this.writes.get(id);
    const storage = (this.app as any).secretStorage;
    if (storage?.getSecret) return String(await storage.getSecret(id) ?? "");
    return this.volatile.get(id) ?? "";
  }

  async set(id: string, value: string): Promise<void> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      const storage = (this.app as any).secretStorage;
      if (storage?.setSecret) {
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
    return Boolean((this.app as any).secretStorage?.setSecret);
  }
}
