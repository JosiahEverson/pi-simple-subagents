import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { Extension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { filterWorkerExtensions } from "../shared/worker-extensions.ts";

function extension(resolvedPath: string): Extension {
  return { resolvedPath } as Extension;
}

function createPackage(root: string, name: string): string {
  const entry = join(root, "extension", "index.ts");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name }));
  writeFileSync(entry, "export default () => {};\n");
  return entry;
}

describe("worker extension discovery", () => {
  it("recognizes symlinked and alternate copies while preserving unrelated globals", () => {
    const temp = mkdtempSync(join(tmpdir(), "pi-worker-extensions-"));
    try {
      const localRoot = join(temp, "local-copy");
      const localEntry = createPackage(localRoot, "pi-subagent-workflows");

      const linkedRoot = join(temp, "linked-copy");
      symlinkSync(localRoot, linkedRoot, "dir");
      const linkedEntry = join(linkedRoot, "extension", "index.ts");

      const npmEntry = createPackage(
        join(temp, "node_modules", "pi-subagent-workflows"),
        "pi-subagent-workflows",
      );

      const fileAliasRoot = join(temp, "file-alias-package");
      const fileAliasEntry = createPackage(fileAliasRoot, "unrelated-file-alias");
      rmSync(fileAliasEntry);
      symlinkSync(localEntry, fileAliasEntry, "file");

      const unrelatedEntry = createPackage(join(temp, "unrelated"), "unrelated-extension");
      const similarNameEntry = createPackage(
        join(temp, "similar-name"),
        "pi-subagent-workflows-helper",
      );
      const currentEntry = fileURLToPath(new URL("../extension/index.ts", import.meta.url));
      const errors = [{ path: "/broken.ts", error: "load failed" }];
      const runtime = {} as LoadExtensionsResult["runtime"];
      const base: LoadExtensionsResult = {
        extensions: [
          extension(linkedEntry),
          extension(npmEntry),
          extension(fileAliasEntry),
          extension(currentEntry),
          extension(unrelatedEntry),
          extension(similarNameEntry),
        ],
        errors,
        runtime,
      };

      const filtered = filterWorkerExtensions(base);

      assert.deepEqual(
        filtered.extensions.map((item) => item.resolvedPath),
        [unrelatedEntry, similarNameEntry],
      );
      assert.equal(filtered.errors, errors);
      assert.equal(filtered.runtime, runtime);
      assert.equal(base.extensions.length, 6, "the discovered base result remains unchanged");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
