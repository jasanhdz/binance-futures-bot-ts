import { createHmac } from 'node:crypto';

export const BINANCE_USDM_PRODUCTION_ORIGIN = 'https://fapi.binance.com';
export const AUDIT_MODE = 'READ_ONLY_RECONCILIATION' as const;
export const DEFAULT_RECV_WINDOW_MS = 5_000;

export const AUDIT_ENDPOINTS = [
  '/fapi/v3/account',
  '/fapi/v3/positionRisk',
  '/fapi/v1/positionSide/dual',
  '/fapi/v1/openOrders',
  '/fapi/v1/openAlgoOrders',
] as const;

export type AuditEndpoint = (typeof AUDIT_ENDPOINTS)[number];

export type AuditFailureCode =
  | 'AEGIS_AUDIT_NON_GET_METHOD_PROHIBITED'
  | 'AEGIS_AUDIT_ENDPOINT_NOT_ALLOWLISTED'
  | 'AEGIS_AUDIT_REQUEST_BODY_PROHIBITED'
  | 'AEGIS_AUDIT_REDIRECT_PROHIBITED'
  | 'AEGIS_AUDIT_MUTATION_ADAPTER_PROHIBITED'
  | 'AEGIS_AUDIT_UNSUPPORTED_QUERY_PARAMETER'
  | 'AEGIS_AUDIT_WRONG_HOST'
  | 'AEGIS_AUDIT_MODE_INVALID'
  | 'AEGIS_AUDIT_CREDENTIAL_ABSENT'
  | 'AEGIS_AUDIT_RECV_WINDOW_EXCESSIVE'
  | 'AEGIS_AUDIT_AUTHENTICATION_FAILED'
  | 'AEGIS_AUDIT_ENDPOINT_FAILURE';

export class AuditPolicyError extends Error {
  constructor(readonly code: AuditFailureCode) {
    super(code);
    this.name = 'AuditPolicyError';
  }
}

export interface AuditNetworkCounters {
  total_network_attempts: number;
  public_get_requests: number;
  authenticated_user_data_get_requests: number;
  non_get_attempts: number;
  non_allowlisted_endpoint_attempts: number;
  redirects: number;
  retries: number;
  rate_limit_responses: number;
  authentication_failures: number;
  time_sync_failures: number;
  mutation_requests: number;
  trade_requests: number;
  order_requests: number;
  cancellation_requests: number;
  leverage_margin_mutation_requests: number;
  money_movement_requests: number;
}

export function emptyAuditNetworkCounters(): AuditNetworkCounters {
  return {
    total_network_attempts: 0,
    public_get_requests: 0,
    authenticated_user_data_get_requests: 0,
    non_get_attempts: 0,
    non_allowlisted_endpoint_attempts: 0,
    redirects: 0,
    retries: 0,
    rate_limit_responses: 0,
    authentication_failures: 0,
    time_sync_failures: 0,
    mutation_requests: 0,
    trade_requests: 0,
    order_requests: 0,
    cancellation_requests: 0,
    leverage_margin_mutation_requests: 0,
    money_movement_requests: 0,
  };
}

export interface AuditPolicyInput {
  method: unknown;
  path: unknown;
  origin: unknown;
  mode: unknown;
  body?: unknown;
  queryParameterNames?: readonly string[];
}

export function assertAuditRequestPolicy(input: AuditPolicyInput): asserts input is {
  method: 'GET';
  path: AuditEndpoint;
  origin: typeof BINANCE_USDM_PRODUCTION_ORIGIN;
  mode: typeof AUDIT_MODE;
  body?: undefined;
  queryParameterNames?: readonly ('timestamp' | 'recvWindow' | 'signature')[];
} {
  if (input.mode !== AUDIT_MODE) throw new AuditPolicyError('AEGIS_AUDIT_MODE_INVALID');
  if (input.method !== 'GET') throw new AuditPolicyError('AEGIS_AUDIT_NON_GET_METHOD_PROHIBITED');
  if (!AUDIT_ENDPOINTS.includes(input.path as AuditEndpoint)) {
    throw new AuditPolicyError('AEGIS_AUDIT_ENDPOINT_NOT_ALLOWLISTED');
  }
  if (input.origin !== BINANCE_USDM_PRODUCTION_ORIGIN) {
    throw new AuditPolicyError('AEGIS_AUDIT_WRONG_HOST');
  }
  if (input.body !== undefined) throw new AuditPolicyError('AEGIS_AUDIT_REQUEST_BODY_PROHIBITED');
  const allowed = new Set(['timestamp', 'recvWindow', 'signature']);
  if ((input.queryParameterNames ?? []).some((name) => !allowed.has(name))) {
    throw new AuditPolicyError('AEGIS_AUDIT_UNSUPPORTED_QUERY_PARAMETER');
  }
}

export interface ReadOnlyAuditTransportRequest {
  readonly method: 'GET';
  readonly url: string;
  readonly headers: Readonly<{ 'X-MBX-APIKEY': string }>;
  readonly redirect: 'error';
  readonly signal: AbortSignal;
}

export interface ReadOnlyAuditTransportResponse {
  readonly status: number;
  readonly url: string;
  readonly redirected: boolean;
  json(): Promise<unknown>;
}

export interface ReadOnlyAuditTransport {
  readonly kind: 'AEGIS_READ_ONLY_GET_TRANSPORT';
  get(request: ReadOnlyAuditTransportRequest): Promise<ReadOnlyAuditTransportResponse>;
}

const defaultTransport: ReadOnlyAuditTransport = {
  kind: 'AEGIS_READ_ONLY_GET_TRANSPORT',
  async get(request) {
    return fetch(request.url, {
      method: request.method,
      headers: request.headers,
      redirect: request.redirect,
      signal: request.signal,
    });
  },
};

function assertReadOnlyTransport(transport: ReadOnlyAuditTransport): void {
  const keys = Object.keys(transport).sort();
  if (
    transport.kind !== 'AEGIS_READ_ONLY_GET_TRANSPORT' ||
    typeof transport.get !== 'function' ||
    keys.some(
      (key) =>
        !['get', 'kind'].includes(key) &&
        typeof (transport as unknown as Record<string, unknown>)[key] === 'function',
    )
  ) {
    throw new AuditPolicyError('AEGIS_AUDIT_MUTATION_ADAPTER_PROHIBITED');
  }
}

export interface AuditClientOptions {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly mode: typeof AUDIT_MODE;
  readonly origin?: typeof BINANCE_USDM_PRODUCTION_ORIGIN;
  readonly recvWindowMs?: number;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
  readonly transport?: ReadOnlyAuditTransport;
}

export interface AuditedResponse<T = unknown> {
  readonly endpoint: AuditEndpoint;
  readonly requested_at_utc: string;
  readonly completed_at_utc: string;
  readonly value: T;
}

export class BinanceUsdmReadOnlyAuditClient {
  readonly counters = emptyAuditNetworkCounters();
  private readonly origin: typeof BINANCE_USDM_PRODUCTION_ORIGIN;
  private readonly recvWindowMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly transport: ReadOnlyAuditTransport;

  constructor(private readonly options: AuditClientOptions) {
    if (options.mode !== AUDIT_MODE) throw new AuditPolicyError('AEGIS_AUDIT_MODE_INVALID');
    if (!options.apiKey || !options.apiSecret) {
      throw new AuditPolicyError('AEGIS_AUDIT_CREDENTIAL_ABSENT');
    }
    this.origin = options.origin ?? BINANCE_USDM_PRODUCTION_ORIGIN;
    this.recvWindowMs = options.recvWindowMs ?? DEFAULT_RECV_WINDOW_MS;
    this.timeoutMs = options.requestTimeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.transport = options.transport ?? defaultTransport;
    if (this.recvWindowMs <= 0 || this.recvWindowMs > DEFAULT_RECV_WINDOW_MS) {
      throw new AuditPolicyError('AEGIS_AUDIT_RECV_WINDOW_EXCESSIVE');
    }
    assertReadOnlyTransport(this.transport);
    assertAuditRequestPolicy({
      method: 'GET',
      path: AUDIT_ENDPOINTS[0],
      origin: this.origin,
      mode: options.mode,
    });
  }

  getAccountInformationV3(): Promise<AuditedResponse> {
    return this.#get('/fapi/v3/account');
  }

  getPositionInformationV3(): Promise<AuditedResponse> {
    return this.#get('/fapi/v3/positionRisk');
  }

  getCurrentPositionMode(): Promise<AuditedResponse> {
    return this.#get('/fapi/v1/positionSide/dual');
  }

  getAllOpenOrders(): Promise<AuditedResponse> {
    return this.#get('/fapi/v1/openOrders');
  }

  getAllOpenAlgoOrders(): Promise<AuditedResponse> {
    return this.#get('/fapi/v1/openAlgoOrders');
  }

  async #get(endpoint: AuditEndpoint): Promise<AuditedResponse> {
    assertAuditRequestPolicy({
      method: 'GET',
      path: endpoint,
      origin: this.origin,
      mode: this.options.mode,
      queryParameterNames: ['timestamp', 'recvWindow', 'signature'],
    });
    const requestedAt = this.now();
    const unsigned = `recvWindow=${this.recvWindowMs}&timestamp=${requestedAt}`;
    const signature = createHmac('sha256', this.options.apiSecret).update(unsigned).digest('hex');
    const url = `${this.origin}${endpoint}?${unsigned}&signature=${signature}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    this.counters.total_network_attempts += 1;
    this.counters.authenticated_user_data_get_requests += 1;
    try {
      const response = await this.transport.get({
        method: 'GET',
        url,
        headers: { 'X-MBX-APIKEY': this.options.apiKey },
        redirect: 'error',
        signal: controller.signal,
      });
      const responseUrl = new URL(response.url || url);
      if (response.redirected || responseUrl.origin !== this.origin) {
        this.counters.redirects += 1;
        throw new AuditPolicyError('AEGIS_AUDIT_REDIRECT_PROHIBITED');
      }
      const value = await response.json();
      if (response.status === 429) this.counters.rate_limit_responses += 1;
      if (response.status === 401 || response.status === 403) {
        this.counters.authentication_failures += 1;
        throw new AuditPolicyError('AEGIS_AUDIT_AUTHENTICATION_FAILED');
      }
      if (response.status < 200 || response.status >= 300) {
        if (isBinanceTimeError(value)) this.counters.time_sync_failures += 1;
        throw new AuditPolicyError('AEGIS_AUDIT_ENDPOINT_FAILURE');
      }
      return {
        endpoint,
        requested_at_utc: new Date(requestedAt).toISOString(),
        completed_at_utc: new Date(this.now()).toISOString(),
        value,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isBinanceTimeError(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'code' in value &&
      ((value as { code?: unknown }).code === -1021 ||
        (value as { code?: unknown }).code === '-1021'),
  );
}
