export interface RuntimeShutdownDeps {
  closeAdmission(): void;
  stopProducers(): Promise<void>;
  activeTasks(): readonly Promise<unknown>[];
  flushResources(): readonly (() => Promise<unknown> | undefined)[];
  closeMutations(): Promise<void>;
}

export class RuntimeShutdownError extends Error {
  constructor(public readonly failures: readonly unknown[]) {
    super(`RUNTIME_SHUTDOWN_FAILED:${failures.length}`);
  }
}

/** Owns shutdown ordering, not strategy policy. A failed stop remains failed. */
export class RuntimeShutdown {
  private completion?: Promise<void>;

  stop(deps: RuntimeShutdownDeps): Promise<void> {
    if (this.completion) return this.completion;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.completion = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const failures: unknown[] = [];
    // Publish the promise before callbacks so a reentrant stop sees the same drain.
    try {
      deps.closeAdmission();
    } catch (error) {
      failures.push(error);
    }
    void this.drain(deps, failures).then(resolve, reject);
    return this.completion;
  }

  private async drain(deps: RuntimeShutdownDeps, failures: unknown[]): Promise<void> {
    try {
      await deps.stopProducers();
    } catch (error) {
      failures.push(error);
    }
    // Tasks own mutation/projection failures; wait for all without abandoning stores.
    // Re-snapshot because a previously admitted task may register child work.
    let active = deps.activeTasks();
    while (active.length) {
      await Promise.allSettled(active);
      active = deps.activeTasks();
    }
    let flushes: readonly (() => Promise<unknown> | undefined)[] = [];
    try {
      flushes = deps.flushResources();
    } catch (error) {
      failures.push(error);
    }
    const results = await Promise.allSettled(flushes.map((flush) => Promise.resolve().then(flush)));
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
    // Closing drains mutation-local work before releasing the writer, even if a sink failed.
    try {
      await deps.closeMutations();
    } catch (error) {
      if (error instanceof RuntimeShutdownError) failures.push(...error.failures);
      else failures.push(error);
    }
    if (failures.length) throw new RuntimeShutdownError(failures);
  }
}
