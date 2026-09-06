import { describe, expect, it, vi } from 'vitest';
import { RuntimeShutdown, RuntimeShutdownError, type RuntimeShutdownDeps } from './RuntimeShutdown';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const events: string[] = [];
  const tasks = new Set<Promise<unknown>>();
  const deps: RuntimeShutdownDeps = {
    closeAdmission: vi.fn(() => {
      events.push('admission-closed');
    }),
    stopProducers: vi.fn(async () => {
      events.push('producers-stopped');
    }),
    activeTasks: () => [...tasks],
    flushResources: () => [
      async () => {
        events.push('state-flush');
      },
      async () => {
        events.push('sink-drain');
      },
    ],
    closeMutations: vi.fn(async () => {
      events.push('mutations-closed');
    }),
  };
  return { events, tasks, deps, shutdown: new RuntimeShutdown() };
}

describe('RuntimeShutdown consumed by TradingService', () => {
  it.each(['opening', 'replacing-stop', 'closing', 'persisting', 'response-lost'])(
    'drains %s before state and journal close',
    async () => {
      const f = fixture();
      const work = deferred();
      f.tasks.add(work.promise);
      void work.promise.then(() => {
        f.events.push('work-persisted');
        f.tasks.delete(work.promise);
      });
      const stop = f.shutdown.stop(f.deps);
      expect(f.events[0]).toBe('admission-closed');
      expect(f.shutdown.stop(f.deps)).toBe(stop);
      await Promise.resolve();
      expect(f.deps.closeMutations).not.toHaveBeenCalled();
      work.resolve();
      await stop;
      expect(f.events).toEqual([
        'admission-closed',
        'producers-stopped',
        'work-persisted',
        'state-flush',
        'sink-drain',
        'mutations-closed',
      ]);
      expect(f.shutdown.stop(f.deps)).toBe(stop);
      expect(f.deps.closeMutations).toHaveBeenCalledTimes(1);
    },
  );

  it('handles reentrant shutdown from admission closure without starting two drains', async () => {
    const f = fixture();
    let reentrant: Promise<void> | undefined;
    f.deps.closeAdmission = () => {
      reentrant = f.shutdown.stop(f.deps);
    };
    const stop = f.shutdown.stop(f.deps);
    expect(reentrant).toBe(stop);
    await stop;
    expect(f.deps.stopProducers).toHaveBeenCalledTimes(1);
    expect(f.deps.closeMutations).toHaveBeenCalledTimes(1);
  });

  it('collects synchronous and asynchronous failures while attempting every flush and journal close', async () => {
    const f = fixture();
    const errors = [
      new Error('producer'),
      new Error('sync-store'),
      new Error('async-sink'),
      new Error('journal'),
    ];
    f.deps.stopProducers = () => {
      throw errors[0];
    };
    f.deps.flushResources = () => [
      () => {
        throw errors[1];
      },
      async () => {
        throw errors[2];
      },
      async () => {
        f.events.push('healthy-store');
      },
    ];
    f.deps.closeMutations = async () => {
      f.events.push('close-attempted');
      throw errors[3];
    };
    const stop = f.shutdown.stop(f.deps);
    await expect(stop).rejects.toBeInstanceOf(RuntimeShutdownError);
    await expect(stop).rejects.toMatchObject({ failures: errors });
    expect(f.events).toEqual(['admission-closed', 'healthy-store', 'close-attempted']);
    expect(f.shutdown.stop(f.deps)).toBe(stop);
  });

  it('does not release resources if waiting times out outside the drain', async () => {
    const f = fixture();
    const work = deferred();
    f.tasks.add(work.promise);
    void work.promise.then(() => {
      f.tasks.delete(work.promise);
    });
    const stop = f.shutdown.stop(f.deps);
    expect(await Promise.race([stop.then(() => 'closed'), Promise.resolve('timeout')])).toBe(
      'timeout',
    );
    expect(f.deps.closeMutations).not.toHaveBeenCalled();
    work.resolve();
    await stop;
  });

  it('re-snapshots child work admitted by an already-running task', async () => {
    const f = fixture();
    const parent = deferred();
    const child = deferred();
    f.tasks.add(parent.promise);
    void parent.promise.then(() => {
      f.tasks.delete(parent.promise);
      f.tasks.add(child.promise);
    });
    void child.promise.then(() => {
      f.tasks.delete(child.promise);
    });
    const stop = f.shutdown.stop(f.deps);
    parent.resolve();
    await parent.promise;
    await Promise.resolve();
    expect(f.deps.closeMutations).not.toHaveBeenCalled();
    child.resolve();
    await stop;
  });
});
