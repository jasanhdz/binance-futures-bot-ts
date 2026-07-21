import { describe, expect, it } from 'vitest';
import {
  AUDIT_ENDPOINTS,
  AUDIT_MODE,
  assertAuditRequestPolicy,
  AuditPolicyError,
  BinanceUsdmReadOnlyAuditClient,
  type AuditEndpoint,
  type ReadOnlyAuditTransport,
  type ReadOnlyAuditTransportRequest,
} from './binance-usdm-readonly-audit-client';
import {
  classifyOpenOrder,
  classifyPosition,
  isExactDecimalZero,
  reconcileAuditResponses,
  reconcileLocalExchangeState,
} from './binance-usdm-readonly-reconciliation';
import { staticAuditSafetyReport } from './binance-usdm-readonly-static-safety';

function fakeTransport(
  valueForPath: (path: string) => unknown = () => [],
): ReadOnlyAuditTransport & { requests: ReadOnlyAuditTransportRequest[] } {
  const requests: ReadOnlyAuditTransportRequest[] = [];
  return {
    kind: 'AEGIS_READ_ONLY_GET_TRANSPORT',
    requests,
    async get(request) {
      requests.push(request);
      const url = new URL(request.url);
      return {
        status: 200,
        url: request.url,
        redirected: false,
        async json() {
          return valueForPath(url.pathname);
        },
      };
    },
  };
}

function client(transport: ReadOnlyAuditTransport, now = () => 1_784_656_100_000) {
  return new BinanceUsdmReadOnlyAuditClient({
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
    mode: AUDIT_MODE,
    transport,
    now,
  });
}

const timestamp = '2026-07-21T19:08:20.000Z';
const response = (endpoint: AuditEndpoint, value: unknown) => ({
  endpoint,
  requested_at_utc: timestamp,
  completed_at_utc: timestamp,
  value,
});

function completeResponses(overrides: Record<string, unknown> = {}) {
  return {
    account: response('/fapi/v3/account', {
      totalPositionInitialMargin: '0.00000000',
      totalOpenOrderInitialMargin: '0.00000000',
    }),
    positions: response('/fapi/v3/positionRisk', []),
    mode: response('/fapi/v1/positionSide/dual', { dualSidePosition: false }),
    regularOrders: response('/fapi/v1/openOrders', []),
    algoOrders: response('/fapi/v1/openAlgoOrders', []),
    ...overrides,
  };
}

describe('Binance USD-M read-only audit network boundary', () => {
  const methodNames: Array<[AuditEndpoint, keyof BinanceUsdmReadOnlyAuditClient]> = [
    ['/fapi/v3/account', 'getAccountInformationV3'],
    ['/fapi/v3/positionRisk', 'getPositionInformationV3'],
    ['/fapi/v1/positionSide/dual', 'getCurrentPositionMode'],
    ['/fapi/v1/openOrders', 'getAllOpenOrders'],
    ['/fapi/v1/openAlgoOrders', 'getAllOpenAlgoOrders'],
  ];

  for (const [endpoint, method] of methodNames) {
    it(`accepts only GET for ${endpoint}`, async () => {
      const transport = fakeTransport((path) =>
        path.includes('dual') ? { dualSidePosition: false } : [],
      );
      await (client(transport)[method] as () => Promise<unknown>)();
      expect(transport.requests).toHaveLength(1);
      expect(transport.requests[0].method).toBe('GET');
      expect(new URL(transport.requests[0].url).pathname).toBe(endpoint);
      expect(transport.requests[0].redirect).toBe('error');
      expect('body' in transport.requests[0]).toBe(false);
    });
  }

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    it(`rejects ${method} before transport`, () => {
      expect(() =>
        assertAuditRequestPolicy({
          method,
          path: '/fapi/v3/account',
          origin: 'https://fapi.binance.com',
          mode: AUDIT_MODE,
        }),
      ).toThrow('AEGIS_AUDIT_NON_GET_METHOD_PROHIBITED');
    });
  }

  for (const path of [
    '/fapi/v1/order',
    '/fapi/v1/allOpenOrders',
    '/fapi/v1/leverage',
    '/fapi/v1/marginType',
    '/sapi/v1/futures/transfer',
    '/fapi/v1/batchOrders',
  ]) {
    it(`rejects non-allowlisted endpoint ${path}`, () => {
      expect(() =>
        assertAuditRequestPolicy({
          method: 'GET',
          path,
          origin: 'https://fapi.binance.com',
          mode: AUDIT_MODE,
        }),
      ).toThrow('AEGIS_AUDIT_ENDPOINT_NOT_ALLOWLISTED');
    });
  }

  it('rejects a request body', () => {
    expect(() =>
      assertAuditRequestPolicy({
        method: 'GET',
        path: '/fapi/v3/account',
        origin: 'https://fapi.binance.com',
        mode: AUDIT_MODE,
        body: {},
      }),
    ).toThrow('AEGIS_AUDIT_REQUEST_BODY_PROHIBITED');
  });

  it('rejects unsupported query parameters', () => {
    expect(() =>
      assertAuditRequestPolicy({
        method: 'GET',
        path: '/fapi/v3/account',
        origin: 'https://fapi.binance.com',
        mode: AUDIT_MODE,
        queryParameterNames: ['timestamp', 'symbol'],
      }),
    ).toThrow('AEGIS_AUDIT_UNSUPPORTED_QUERY_PARAMETER');
  });

  it('rejects the wrong production host', () => {
    expect(() =>
      assertAuditRequestPolicy({
        method: 'GET',
        path: '/fapi/v3/account',
        origin: 'https://testnet.binancefuture.com',
        mode: AUDIT_MODE,
      }),
    ).toThrow('AEGIS_AUDIT_WRONG_HOST');
  });

  it('rejects an invalid audit mode', () => {
    expect(() =>
      assertAuditRequestPolicy({
        method: 'GET',
        path: '/fapi/v3/account',
        origin: 'https://fapi.binance.com',
        mode: 'LIVE',
      }),
    ).toThrow('AEGIS_AUDIT_MODE_INVALID');
  });

  it('rejects a mutating adapter-shaped transport', () => {
    expect(
      () =>
        new BinanceUsdmReadOnlyAuditClient({
          apiKey: 'key',
          apiSecret: 'secret',
          mode: AUDIT_MODE,
          transport: {
            kind: 'AEGIS_READ_ONLY_GET_TRANSPORT',
            get: async () => ({ status: 200, url: '', redirected: false, json: async () => [] }),
            post: async () => undefined,
          } as unknown as ReadOnlyAuditTransport,
        }),
    ).toThrow('AEGIS_AUDIT_MUTATION_ADAPTER_PROHIBITED');
  });

  it('rejects excessive recvWindow', () => {
    expect(
      () =>
        new BinanceUsdmReadOnlyAuditClient({
          apiKey: 'key',
          apiSecret: 'secret',
          mode: AUDIT_MODE,
          recvWindowMs: 5_001,
        }),
    ).toThrow('AEGIS_AUDIT_RECV_WINDOW_EXCESSIVE');
  });

  it('uses timestamp and bounded recvWindow without returning signature material', async () => {
    const transport = fakeTransport();
    const result = await client(transport).getAccountInformationV3();
    const url = new URL(transport.requests[0].url);
    expect(url.searchParams.get('timestamp')).toBe('1784656100000');
    expect(url.searchParams.get('recvWindow')).toBe('5000');
    expect(url.searchParams.get('signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(/signature|test-api-key|test-api-secret/);
  });

  it('rejects a cross-host redirect response', async () => {
    const transport: ReadOnlyAuditTransport = {
      kind: 'AEGIS_READ_ONLY_GET_TRANSPORT',
      async get() {
        return { status: 200, url: 'https://example.com/', redirected: true, json: async () => [] };
      },
    };
    await expect(client(transport).getAccountInformationV3()).rejects.toThrow(
      'AEGIS_AUDIT_REDIRECT_PROHIBITED',
    );
  });

  it('never exposes credential values in policy errors', () => {
    const canary = 'distinctive-secret-canary';
    try {
      new BinanceUsdmReadOnlyAuditClient({ apiKey: '', apiSecret: canary, mode: AUDIT_MODE });
    } catch (error) {
      expect(String(error)).not.toContain(canary);
      expect(error).toBeInstanceOf(AuditPolicyError);
    }
  });

  it('tracks authenticated GETs and keeps every mutation counter zero', async () => {
    const transport = fakeTransport();
    const auditClient = client(transport);
    await auditClient.getAccountInformationV3();
    expect(auditClient.counters.authenticated_user_data_get_requests).toBe(1);
    expect(auditClient.counters.total_network_attempts).toBe(1);
    expect(auditClient.counters.mutation_requests).toBe(0);
    expect(auditClient.counters.trade_requests).toBe(0);
    expect(auditClient.counters.order_requests).toBe(0);
  });
});

describe('exact-decimal position reconciliation', () => {
  for (const zero of ['0', '0.0', '000.000', '+0.000', '-0.000']) {
    it(`classifies ${zero} as exact zero`, () => expect(isExactDecimalZero(zero)).toBe(true));
  }

  it('classifies a very small decimal as active', () =>
    expect(isExactDecimalZero('0.00000001')).toBe(false));

  const basePosition = {
    symbol: 'BTCUSDT',
    entryPrice: '100.00',
    markPrice: '101.00',
    notional: '1.01',
    isolated: false,
    leverage: '1',
    unRealizedProfit: '0.01',
  };

  it('interprets a positive one-way position as long', () => {
    expect(
      classifyPosition({ ...basePosition, positionSide: 'BOTH', positionAmt: '0.01' }, 'ONE_WAY')
        ?.exposure_direction,
    ).toBe('LONG');
  });

  it('interprets a negative one-way position as short', () => {
    expect(
      classifyPosition({ ...basePosition, positionSide: 'BOTH', positionAmt: '-0.01' }, 'ONE_WAY')
        ?.exposure_direction,
    ).toBe('SHORT');
  });

  it('interprets hedge LONG independently', () => {
    expect(
      classifyPosition({ ...basePosition, positionSide: 'LONG', positionAmt: '0.01' }, 'HEDGE')
        ?.exposure_direction,
    ).toBe('LONG');
  });

  it('interprets hedge SHORT independently', () => {
    expect(
      classifyPosition({ ...basePosition, positionSide: 'SHORT', positionAmt: '0.01' }, 'HEDGE')
        ?.exposure_direction,
    ).toBe('SHORT');
  });

  it('supports simultaneous hedge LONG and SHORT positions', () => {
    const rows = [
      classifyPosition({ ...basePosition, positionSide: 'LONG', positionAmt: '0.01' }, 'HEDGE'),
      classifyPosition({ ...basePosition, positionSide: 'SHORT', positionAmt: '0.02' }, 'HEDGE'),
    ];
    expect(rows.filter(Boolean)).toHaveLength(2);
  });

  it('rejects a position side inconsistent with account mode', () => {
    expect(() =>
      classifyPosition({ ...basePosition, positionSide: 'LONG', positionAmt: '0.01' }, 'ONE_WAY'),
    ).toThrow('AEGIS_AUDIT_POSITION_MODE_CONFLICT');
  });
});

describe('open-order and account-surface reconciliation', () => {
  const order = { orderId: 1, symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH' };

  for (const [type, expected] of [
    ['LIMIT', 'REGULAR_ENTRY'],
    ['STOP_MARKET', 'STOP_LOSS'],
    ['TAKE_PROFIT_MARKET', 'TAKE_PROFIT'],
    ['TRAILING_STOP_MARKET', 'TRAILING_STOP'],
    ['UNRECOGNIZED', 'UNKNOWN'],
  ] as const) {
    it(`classifies ${type} as ${expected}`, () => {
      expect(classifyOpenOrder({ ...order, type }, 'REGULAR').classification).toBe(expected);
    });
  }

  it('classifies reduce-only independently', () => {
    expect(
      classifyOpenOrder({ ...order, type: 'LIMIT', reduceOnly: true }, 'REGULAR').classification,
    ).toBe('REDUCE_ONLY');
  });

  it('classifies close-position independently', () => {
    expect(
      classifyOpenOrder({ ...order, type: 'STOP_MARKET', closePosition: true }, 'ALGO')
        .classification,
    ).toBe('CLOSE_POSITION');
  });

  it('passes a complete flat account', () => {
    const result = reconcileAuditResponses(completeResponses());
    expect(result.audit_completeness).toBe('COMPLETE');
    expect(result.safe_retirement_exchange_gate).toBe(true);
  });

  it('preserves service for an active position', () => {
    const positions = [
      {
        symbol: 'BTCUSDT',
        positionSide: 'BOTH',
        positionAmt: '0.001',
        entryPrice: '1',
        markPrice: '1',
        notional: '0.001',
        leverage: '1',
        unRealizedProfit: '0',
        isolated: false,
      },
    ];
    const result = reconcileAuditResponses(
      completeResponses({ positions: response('/fapi/v3/positionRisk', positions) }),
    );
    expect(result.counters.active_position_count).toBe(1);
    expect(result.safe_retirement_exchange_gate).toBe(false);
  });

  it('preserves service for a regular open order', () => {
    const orders = [{ ...order, type: 'LIMIT' }];
    const result = reconcileAuditResponses(
      completeResponses({ regularOrders: response('/fapi/v1/openOrders', orders) }),
    );
    expect(result.counters.regular_open_order_count).toBe(1);
    expect(result.safe_retirement_exchange_gate).toBe(false);
  });

  it('preserves service for a TP algo order', () => {
    const orders = [
      {
        algoId: 2,
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'BOTH',
        orderType: 'TAKE_PROFIT_MARKET',
      },
    ];
    const result = reconcileAuditResponses(
      completeResponses({ algoOrders: response('/fapi/v1/openAlgoOrders', orders) }),
    );
    expect(result.counters.take_profit_order_count).toBe(1);
    expect(result.safe_retirement_exchange_gate).toBe(false);
  });

  it('preserves service for an unknown algo order', () => {
    const orders = [{ algoId: 2, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH' }];
    const result = reconcileAuditResponses(
      completeResponses({ algoOrders: response('/fapi/v1/openAlgoOrders', orders) }),
    );
    expect(result.counters.unknown_order_count).toBe(1);
    expect(result.safe_retirement_exchange_gate).toBe(false);
  });

  it('blocks retirement when account position margin conflicts with position surface', () => {
    const result = reconcileAuditResponses(
      completeResponses({
        account: response('/fapi/v3/account', {
          totalPositionInitialMargin: '1',
          totalOpenOrderInitialMargin: '0',
        }),
      }),
    );
    expect(result.audit_completeness).toBe('INCOMPLETE_SURFACE_INCONSISTENCY');
    expect(result.safe_retirement_exchange_gate).toBe(false);
  });

  it('blocks retirement when account order margin conflicts with order surfaces', () => {
    const result = reconcileAuditResponses(
      completeResponses({
        account: response('/fapi/v3/account', {
          totalPositionInitialMargin: '0',
          totalOpenOrderInitialMargin: '1',
        }),
      }),
    );
    expect(result.audit_completeness).toBe('INCOMPLETE_SURFACE_INCONSISTENCY');
  });

  it('blocks retirement on malformed endpoint schema', () => {
    const result = reconcileAuditResponses(
      completeResponses({ positions: response('/fapi/v3/positionRisk', {}) }),
    );
    expect(result.audit_completeness).toBe('INCOMPLETE_SCHEMA');
    expect(result.safe_retirement_exchange_gate).toBe(false);
  });

  it('blocks retirement on temporal incoherence', () => {
    const result = reconcileAuditResponses(
      completeResponses({
        algoOrders: {
          ...response('/fapi/v1/openAlgoOrders', []),
          completed_at_utc: '2026-07-21T19:09:00.001Z',
        },
      }),
    );
    expect(result.audit_completeness).toBe('INCOMPLETE_TEMPORAL_COHERENCE');
    expect(result.safe_retirement_exchange_gate).toBe(false);
  });

  it('requires complete local state before retirement', () => {
    const result = reconcileAuditResponses(completeResponses());
    expect(
      reconcileLocalExchangeState(
        {
          state_file_count: 0,
          managed_position_count: 0,
          pending_order_count: 0,
          mutation_in_flight: false,
          incomplete_state_count: 1,
          managed_position_files: [],
          pending_order_files: [],
        },
        result,
      ),
    ).toBe('LOCAL_STATE_INCOMPLETE');
  });

  it('requires local and exchange active state to agree', () => {
    const result = reconcileAuditResponses(completeResponses());
    expect(
      reconcileLocalExchangeState(
        {
          state_file_count: 1,
          managed_position_count: 1,
          pending_order_count: 0,
          mutation_in_flight: false,
          incomplete_state_count: 0,
          managed_position_files: ['state.json'],
          pending_order_files: [],
        },
        result,
      ),
    ).toBe('LOCAL_EXCHANGE_STATE_INCONSISTENT');
  });

  it('passes only complete local and exchange flat state', () => {
    const result = reconcileAuditResponses(completeResponses());
    expect(
      reconcileLocalExchangeState(
        {
          state_file_count: 1,
          managed_position_count: 0,
          pending_order_count: 0,
          mutation_in_flight: false,
          incomplete_state_count: 0,
          managed_position_files: [],
          pending_order_files: [],
        },
        result,
      ),
    ).toBe('CONSISTENT_FLAT');
  });
});

describe('static mutation surface', () => {
  it('contains only the dedicated audit import graph', () => {
    const report = staticAuditSafetyReport(process.cwd());
    expect(report.result).toBe('PASS');
    expect(report.forbidden_imports).toEqual([]);
    expect(report.network_surface).toHaveLength(5);
  });

  it('does not expose an arbitrary request method', () => {
    const transport = fakeTransport();
    const publicNames = Object.getOwnPropertyNames(Object.getPrototypeOf(client(transport))).filter(
      (name) => name !== 'constructor',
    );
    expect(publicNames).toEqual([
      'getAccountInformationV3',
      'getPositionInformationV3',
      'getCurrentPositionMode',
      'getAllOpenOrders',
      'getAllOpenAlgoOrders',
    ]);
    expect(publicNames).not.toContain('request');
    expect(publicNames).not.toContain('signedRequest');
    expect(publicNames).not.toContain('send');
  });

  it('freezes exactly five endpoint paths', () => {
    expect(AUDIT_ENDPOINTS).toEqual([
      '/fapi/v3/account',
      '/fapi/v3/positionRisk',
      '/fapi/v1/positionSide/dual',
      '/fapi/v1/openOrders',
      '/fapi/v1/openAlgoOrders',
    ]);
  });
});
