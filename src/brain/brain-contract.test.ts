import { describe, expect, it, vi } from 'vitest';
import { AxiosInstance } from 'axios';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BRAIN_CONTRACT_VERSION, BrainManifest, DecisionResponse, parseBrainManifest, parseDecisionResponse } from './contract';
import { HttpBrainClient } from './client';
import { validateBrainManifest } from './manifest';

const symbols = ['ETHUSDT', 'BTCUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT', 'LTCUSDT'];
const symbolHash = 'f6448e67daf1d017e16cc6b331f6494e97e178824474994fff08864303ccd348';

export const manifestFixture = (): BrainManifest => ({
  contract_version: BRAIN_CONTRACT_VERSION, universe_id: 'aegis-operational-eleven-v1', symbols,
  symbol_set_hash: symbolHash, timeframe: '5m', config_version: 'aegis-scientific-config-v1',
  config_hash: 'c'.repeat(64), model_bundle_id: 'aegis-offline-reference-v1',
  feature_schema_version: 'aegis-features-v1', feature_hash: 'f'.repeat(64),
  capabilities: ['SCIENTIFIC_EVALUATION'], build_id: 'test', ready: true,
});

export const decisionFixture = (): DecisionResponse => ({
  contract_version: BRAIN_CONTRACT_VERSION, decision_id: 'decision-1', decision_cycle_id: 'cycle-1',
  generated_at: '2026-07-17T12:00:00Z', expires_at: '2026-07-17T12:00:30Z', status: 'SELECTED',
  universe_id: 'aegis-operational-eleven-v1', symbol_set_hash: symbolHash,
  config_version: 'aegis-scientific-config-v1', model_bundle_id: 'aegis-offline-reference-v1',
  feature_schema_version: 'aegis-features-v1', evidence_hash: 'e'.repeat(64), warnings: [], reason_codes: ['ELIGIBLE'],
  selected: [{ candidate_id: 'candidate-1', symbol: 'ADAUSDT', side: 'SHORT', raw_score: 0.8,
    calibrated_score: 0.7, confidence: 0.8, uncertainty: 0.2, regime: 'BEAR_TREND', compatibility: 0.8,
    expected_return: 0.01, horizon_bars: 12, risk_intent: { stop_distance_fraction: 0.02, maximum_holding_bars: 12 },
    reason_codes: ['ELIGIBLE'], evidence_references: ['features:x'], model_bundle_id: 'aegis-offline-reference-v1',
    feature_hash: 'f'.repeat(64), candidate_hash: 'a'.repeat(64), eligible: true }],
  ranking: [{ rank: 1, symbol: 'ADAUSDT', candidate_hash: 'a'.repeat(64), score: 0.7, eligible: true, reason_codes: ['ELIGIBLE'] }],
});

describe('brain contract and manifest', () => {
  it('parses versioned fixtures without silent coercion', () => {
    expect(parseBrainManifest(manifestFixture())).toEqual(manifestFixture());
    expect(parseDecisionResponse(decisionFixture())).toEqual(decisionFixture());
    expect(() => parseDecisionResponse({ status: 'SELECTED' })).toThrow();
  });

  it('parses the exact manifest fixture shared with Python', () => {
    const shared = JSON.parse(readFileSync(resolve(process.cwd(), '../tests/fixtures/brain_manifest.json'), 'utf8'));
    expect(parseBrainManifest(shared).symbol_set_hash).toBe(symbolHash);
    expect(parseBrainManifest(shared).feature_hash).toHaveLength(64);
  });

  it('reports every manifest mismatch and fails closed', () => {
    const expected = { contractVersion: BRAIN_CONTRACT_VERSION, universeId: 'aegis-operational-eleven-v1', symbols,
      symbolSetHash: symbolHash, timeframe: '5m', modelBundleId: 'aegis-offline-reference-v1',
      featureSchemaVersion: 'aegis-features-v1', featureHash: 'f'.repeat(64), configVersion: 'aegis-scientific-config-v1' };
    expect(validateBrainManifest(manifestFixture(), expected).compatible).toBe(true);
    expect(validateBrainManifest({ ...manifestFixture(), ready: false, model_bundle_id: 'wrong' }, expected).mismatchCodes)
      .toEqual(['MODEL_BUNDLE_MISMATCH', 'BRAIN_NOT_READY']);
  });

  it('uses bounded HTTP calls and redacts transport failures behind stable codes', async () => {
    const http = { get: vi.fn().mockResolvedValue({ data: manifestFixture() }),
      post: vi.fn().mockResolvedValue({ data: decisionFixture() }) } as unknown as AxiosInstance;
    const client = new HttpBrainClient({ endpoint: 'http://127.0.0.1:8010', requestTimeoutMs: 100, failClosed: true }, http);
    expect((await client.getManifest()).ready).toBe(true);
    expect((await client.evaluate({} as never)).decision_id).toBe('decision-1');
    const broken = new HttpBrainClient({ endpoint: 'http://127.0.0.1:8010', requestTimeoutMs: 100, failClosed: true },
      { get: vi.fn().mockRejectedValue(new Error('secret transport details')) } as unknown as AxiosInstance);
    await expect(broken.getManifest()).rejects.toMatchObject({ code: 'BRAIN_MANIFEST_UNAVAILABLE' });
  });
});
