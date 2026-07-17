import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  configureWorkerSession,
  createWorkerSessionCleanup,
} from "../shared/worker-session.ts";

function fakeSession(options: { shutdownError?: Error; disposeError?: Error } = {}) {
  let shutdowns = 0;
  let disposals = 0;
  return {
    session: {
      extensionRunner: {
        emit: async () => {
          shutdowns += 1;
          if (options.shutdownError) throw options.shutdownError;
        },
      },
      dispose: () => {
        disposals += 1;
        if (options.disposeError) throw options.disposeError;
      },
    },
    counts: () => ({ shutdowns, disposals }),
  };
}

describe("worker session lifecycle", () => {
  it("shuts down and disposes exactly once when direct-worker setup fails", async () => {
    const fake = fakeSession();
    const warnings: string[] = [];

    await assert.rejects(
      configureWorkerSession(fake.session, warnings, async () => {
        throw new Error("bind failed");
      }),
      /bind failed/,
    );

    assert.deepEqual(fake.counts(), { shutdowns: 1, disposals: 1 });
    assert.deepEqual(warnings, []);
  });

  it("is exact-once and finalizes non-fatal lifecycle warnings before persistence", async () => {
    const fake = fakeSession({
      shutdownError: new Error("shutdown handler failed"),
      disposeError: new Error("dispose failed"),
    });
    const warnings: string[] = [];
    const cleanup = createWorkerSessionCleanup(fake.session, warnings);

    await cleanup();
    const persisted = JSON.stringify({ output: "done", warnings });
    await cleanup();

    assert.deepEqual(fake.counts(), { shutdowns: 1, disposals: 1 });
    assert.deepEqual(warnings, [
      "Extension shutdown failed: shutdown handler failed",
      "Worker session disposal failed: dispose failed",
    ]);
    assert.equal(JSON.stringify({ output: "done", warnings }), persisted);
  });
});
