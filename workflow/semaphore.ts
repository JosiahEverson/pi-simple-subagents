export class Semaphore {
  private active = 0;
  private readonly queue: Array<(release: () => void) => void> = [];

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error("Semaphore maximum must be a positive integer.");
  }

  acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next(this.makeRelease());
      else this.active -= 1;
    };
  }
}
