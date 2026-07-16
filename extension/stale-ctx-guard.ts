import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Process-level guard against pi's stale-extension-ctx crashes.
 *
 * Any extension (local or 3rd party) that touches a captured ExtensionContext
 * from a timer or detached promise after session replacement/reload/dispose
 * throws "This extension ctx is stale...". When that happens inside a
 * setTimeout/setInterval callback it surfaces as an uncaughtException, and
 * pi's crash handler hard-exits the whole process.
 *
 * This guard uses process.setUncaughtExceptionCaptureCallback (which preempts
 * the "uncaughtException" event entirely) to:
 *   - swallow stale-ctx errors, logging once per offending source, and
 *   - re-dispatch every other error to pi's crash handler so genuine crashes
 *     still restore the terminal and exit cleanly.
 *
 * State lives on globalThis so the guard installs exactly once per process,
 * surviving extension hot-reloads and session switches.
 */

const GUARD_KEY = Symbol.for("pi-subagent-workflows.stale-ctx-guard");
const STALE_PREFIX = "This extension ctx is stale after session replacement or reload";

interface GuardState {
  installed: boolean;
  seenSources: Set<string>;
}

function getState(): GuardState {
  const holder = globalThis as { [GUARD_KEY]?: GuardState };
  holder[GUARD_KEY] ??= { installed: false, seenSources: new Set() };
  return holder[GUARD_KEY];
}

function logFilePath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "logs", "stale-ctx-guard.log");
}

function isStaleCtxError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    typeof error.message === "string" &&
    error.message.startsWith(STALE_PREFIX)
  );
}

/**
 * Dedupe key: the first stack frame outside pi core / node internals, i.e.
 * the offending extension file. Falls back to the topmost frame.
 */
function sourceKey(error: Error): string {
  const frames = (error.stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "));
  const external = frames.find(
    (line) =>
      !line.includes("@earendil-works/pi-coding-agent") &&
      !line.includes("node:internal"),
  );
  return external ?? frames[0] ?? "unknown source";
}

function logOncePerSource(state: GuardState, error: Error): void {
  const source = sourceKey(error);
  if (state.seenSources.has(source)) return;
  state.seenSources.add(source);
  try {
    const path = logFilePath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      [
        `[${new Date().toISOString()}] intercepted stale-ctx error (further occurrences from this source are suppressed)`,
        `source: ${source}`,
        error.stack ?? error.message,
        "",
        "",
      ].join("\n"),
    );
  } catch {
    // Logging must never take the process down.
  }
}

/** Forward non-stale errors to pi's uncaughtException handler (terminal restore + exit). */
function dispatchToPi(error: unknown): void {
  if (process.listenerCount("uncaughtException") > 0) {
    process.emit("uncaughtException", error as Error);
    return;
  }
  // No handler registered (e.g. non-interactive mode): mimic node's default.
  console.error("Uncaught exception:", error);
  process.exit(1);
}

export function installStaleCtxGuard(): void {
  const state = getState();
  if (state.installed) return;
  if (process.hasUncaughtExceptionCaptureCallback()) {
    // Someone else owns the capture callback; do not clobber it.
    return;
  }
  process.setUncaughtExceptionCaptureCallback((error) => {
    if (isStaleCtxError(error)) {
      logOncePerSource(state, error);
      return;
    }
    dispatchToPi(error);
  });
  state.installed = true;
}
