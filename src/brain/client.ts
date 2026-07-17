/** Port for the Python brain. No transport implementation exists yet. */

import { BrainManifest, DecisionOutcome, DecisionRequest, DecisionResponse } from './contract';

export interface BrainClient {
  getManifest(): Promise<BrainManifest>;
  evaluate(request: DecisionRequest): Promise<DecisionResponse>;
  submitOutcome(outcome: DecisionOutcome): Promise<void>;
}

export interface BrainClientOptions {
  endpoint: string;
  requestTimeoutMs: number;
  failClosed: true;
}

/**
 * TODO: implement this port in infrastructure using the existing HTTP stack.
 * Timeouts, bounded retries, and failures must resolve fail closed.
 */
export type BrainClientFactory = (options: BrainClientOptions) => BrainClient;
