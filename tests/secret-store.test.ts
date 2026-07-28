import assert from "node:assert/strict";
import test from "node:test";

import { SecretStore } from "../src/services/secret-store";

test("SecretStore serializes writes for the same secret", async () => {
  let stored = "";
  const app = {
    secretStorage: {
      async setSecret(_id: string, value: string): Promise<void> {
        if (value === "first") await new Promise((resolve) => setTimeout(resolve, 20));
        stored = value;
      },
      async getSecret(): Promise<string> {
        return stored;
      }
    }
  };
  const secrets = new SecretStore(app as never);

  await Promise.all([
    secrets.set("mineru", "first"),
    secrets.set("mineru", "second")
  ]);

  assert.equal(await secrets.get("mineru"), "second");
});

test("SecretStore fallback remains available for the current runtime", async () => {
  const secrets = new SecretStore({} as never);
  assert.equal(secrets.isPersistent(), false);
  await secrets.set("mineru", "runtime-only");
  assert.equal(await secrets.get("mineru"), "runtime-only");
});
