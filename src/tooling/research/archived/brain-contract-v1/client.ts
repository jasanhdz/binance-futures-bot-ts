/** Bounded HTTP adapter for the Python brain; all failures remain fail closed. */

import axios, { AxiosInstance } from 'axios';
import { BrainManifest, DecisionOutcome, DecisionRequest, DecisionResponse, parseBrainManifest, parseDecisionResponse } from './contract';

export interface BrainClient { getManifest(): Promise<BrainManifest>; evaluate(request: DecisionRequest): Promise<DecisionResponse>; submitOutcome(outcome: DecisionOutcome): Promise<void>; }
export interface BrainClientOptions { endpoint: string; requestTimeoutMs: number; failClosed: true; }

export class BrainClientError extends Error {
  public readonly cause: unknown;
  constructor(public readonly code: string, cause?: unknown) { super(code); this.name = 'BrainClientError'; this.cause = cause; }
}

export class HttpBrainClient implements BrainClient {
  private readonly http: AxiosInstance;
  constructor(private readonly options: BrainClientOptions, http?: AxiosInstance) {
    if (!options.endpoint || options.requestTimeoutMs <= 0 || options.failClosed !== true) throw new Error('INVALID_BRAIN_CLIENT_OPTIONS');
    this.http = http ?? axios.create({ baseURL: options.endpoint, timeout: options.requestTimeoutMs });
  }
  async getManifest(): Promise<BrainManifest> {
    try { return parseBrainManifest((await this.http.get('/manifest')).data); }
    catch (error) { throw new BrainClientError('BRAIN_MANIFEST_UNAVAILABLE', error); }
  }
  async evaluate(request: DecisionRequest): Promise<DecisionResponse> {
    try { return parseDecisionResponse((await this.http.post('/v1/decisions/evaluate', request)).data); }
    catch (error) { throw new BrainClientError('BRAIN_EVALUATION_FAILED_CLOSED', error); }
  }
  async submitOutcome(outcome: DecisionOutcome): Promise<void> {
    try { await this.http.post('/v1/evidence/outcome', outcome); }
    catch (error) { throw new BrainClientError('BRAIN_OUTCOME_SUBMISSION_FAILED', error); }
  }
}

export type BrainClientFactory = (options: BrainClientOptions) => BrainClient;
export const createBrainClient: BrainClientFactory = (options) => new HttpBrainClient(options);
