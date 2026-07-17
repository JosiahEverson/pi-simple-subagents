import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

const PACKAGE_NAME = "pi-subagent-workflows";
const CANONICAL_SELF_ENTRY = canonicalPath(fileURLToPath(new URL("../extension/index.ts", import.meta.url)));

/** Keep normal Pi extension discovery while preventing this package from installing recursive worker tools. */
export function filterWorkerExtensions(base: LoadExtensionsResult): LoadExtensionsResult {
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !isThisPackage(extension.resolvedPath)),
  };
}

function isThisPackage(extensionPath: string): boolean {
  const lexicalPath = resolve(extensionPath);
  if (nearestPackageName(lexicalPath) === PACKAGE_NAME) return true;

  const canonical = canonicalPath(lexicalPath);
  return canonical === CANONICAL_SELF_ENTRY ||
    (canonical !== lexicalPath && nearestPackageName(canonical) === PACKAGE_NAME);
}

function nearestPackageName(path: string): string | undefined {
  let directory = dirname(path);
  const root = parse(directory).root;
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
        return isRecord(manifest) && typeof manifest["name"] === "string"
          ? manifest["name"]
          : undefined;
      } catch {
        return undefined;
      }
    }
    if (directory === root) return undefined;
    directory = dirname(directory);
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
