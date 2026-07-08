export class Semaphore {
  private active = 0;
  private max: number;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];

  constructor(max: number) {
    this.max = max;
  }

  setMax(max: number): void {
    this.max = max;
    this.drain();
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new Error("Aborted while waiting for subagent slot."));
    }

    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }

    return new Promise((resolveAcquire, reject) => {
      const entry = {
        resolve: resolveAcquire,
        reject,
        signal,
        abort: undefined as (() => void) | undefined,
      };
      entry.abort = () => {
        const index = this.queue.indexOf(entry);
        if (index !== -1) this.queue.splice(index, 1);
        reject(new Error("Aborted while waiting for subagent slot."));
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.max && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) return;
      if (entry.signal?.aborted) {
        entry.reject(new Error("Aborted while waiting for subagent slot."));
        continue;
      }
      if (entry.abort) {
        entry.signal?.removeEventListener("abort", entry.abort);
      }
      this.active += 1;
      entry.resolve(() => this.release());
    }
  }
}
