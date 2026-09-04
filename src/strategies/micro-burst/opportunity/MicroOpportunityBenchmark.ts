export interface MicroOpportunityBenchmarkResult {
  readonly samples: number;
  readonly featureBuildMs: Record<'p50' | 'p95' | 'p99', number>;
  readonly inferenceMs: Record<'p50' | 'p95' | 'p99', number>;
  readonly totalMs: Record<'p50' | 'p95' | 'p99', number>;
  readonly heapUsedBytes: number;
  readonly eventLoopLagMs: number;
}

export function summarizeMicroOpportunityBenchmark(input: {
  readonly featureBuildMs: readonly number[];
  readonly inferenceMs: readonly number[];
  readonly totalMs: readonly number[];
  readonly eventLoopLagMs: number;
}): MicroOpportunityBenchmarkResult {
  const percentile = (values: readonly number[], fraction: number): number => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
  };
  const summary = (values: readonly number[]) => ({ p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) });
  return { samples: input.totalMs.length, featureBuildMs: summary(input.featureBuildMs), inferenceMs: summary(input.inferenceMs), totalMs: summary(input.totalMs), heapUsedBytes: process.memoryUsage().heapUsed, eventLoopLagMs: input.eventLoopLagMs };
}
