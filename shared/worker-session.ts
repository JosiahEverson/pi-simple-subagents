interface WorkerSessionLifecycle {
  extensionRunner: {
    emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
  };
  dispose(): void;
}

/** Configure a worker with cleanup already armed, so partial setup cannot leak its session. */
export async function configureWorkerSession<T extends WorkerSessionLifecycle>(
  session: T,
  warnings: string[],
  setup: (session: T) => void | Promise<void>,
): Promise<() => Promise<void>> {
  const cleanup = createWorkerSessionCleanup(session, warnings);
  try {
    await setup(session);
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Emit shutdown and dispose at most once. Extension lifecycle failures remain non-fatal warnings. */
export function createWorkerSessionCleanup(
  session: WorkerSessionLifecycle,
  warnings: string[],
): () => Promise<void> {
  let cleaned = false;
  return async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } catch (error) {
      warnings.push(`Extension shutdown failed: ${errorMessage(error)}`);
    }
    try {
      session.dispose();
    } catch (error) {
      warnings.push(`Worker session disposal failed: ${errorMessage(error)}`);
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
