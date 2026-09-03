type SaveWaiter = {
  generation: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/**
 * Coalesces state writes without making an earlier caller wait for mutations
 * that arrived after its own durable snapshot started.
 */
export class GenerationSaveCoordinator {
  private requestedGeneration = 0;
  private completedGeneration = 0;
  private pumping = false;
  private waiters: SaveWaiter[] = [];

  constructor(private readonly persist: () => Promise<void>) {}

  request() {
    const generation = ++this.requestedGeneration;
    const completion = new Promise<void>((resolve, reject) => {
      this.waiters.push({ generation, resolve, reject });
    });
    this.ensurePump();
    return completion;
  }

  private ensurePump() {
    if (this.pumping) return;
    this.pumping = true;
    void this.pump();
  }

  private async pump() {
    try {
      while (this.completedGeneration < this.requestedGeneration) {
        const savingThrough = this.requestedGeneration;
        try {
          await this.persist();
          this.settleThrough(savingThrough);
        } catch (error) {
          this.settleThrough(savingThrough, error);
        }
        this.completedGeneration = savingThrough;
      }
    } finally {
      this.pumping = false;
      if (this.completedGeneration < this.requestedGeneration) this.ensurePump();
    }
  }

  private settleThrough(generation: number, error?: unknown) {
    const settled = this.waiters.filter((waiter) => waiter.generation <= generation);
    this.waiters = this.waiters.filter((waiter) => waiter.generation > generation);
    for (const waiter of settled) {
      if (error === undefined) waiter.resolve();
      else waiter.reject(error);
    }
  }
}
