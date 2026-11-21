function abortError(): Error {
  return new DOMException("Aborted while waiting for a run slot", "AbortError");
}

/** Admits at most `max` tasks at a time, first come, first served. */
export class Limiter {
  private readonly max: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
  }

  /** Runs the task once a slot is free; an abort while waiting rejects. */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  private acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const admit = () => {
        signal?.removeEventListener("abort", leave);
        this.active += 1;
        resolve();
      };
      const leave = () => {
        this.waiting.splice(this.waiting.indexOf(admit), 1);
        reject(abortError());
      };
      this.waiting.push(admit);
      signal?.addEventListener("abort", leave, { once: true });
    });
  }
}
