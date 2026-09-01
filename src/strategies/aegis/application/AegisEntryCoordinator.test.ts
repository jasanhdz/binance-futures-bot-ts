import { describe, expect, it, vi } from 'vitest';
import { AegisEntryCoordinator } from './AegisEntryCoordinator';
import { AegisEntryGuardOrchestrator } from '../domain/entry/AegisEntryGuardOrchestrator';
import type {
  AegisEntryContext,
  AegisEntryPolicyRuntimeConfig,
} from '../domain/entry/AegisEntryDecisionTypes';

const context = { side: 'LONG' } as AegisEntryContext;
const policy = { enabled: true, guards: {} } as AegisEntryPolicyRuntimeConfig;

describe('AegisEntryCoordinator', () => {
  it('captures causal evidence before evaluating the entry policy', async () => {
    const capture = vi.fn().mockResolvedValue({ schema: 'MARKET_SNAPSHOT_V1' } as any);
    vi.spyOn(AegisEntryGuardOrchestrator, 'evaluate').mockResolvedValue({
      shouldOpen: false,
      finalDecision: 'BLOCK',
      finalReason: 'test_blocked',
      guards: [],
      decisions: {},
      metadata: {},
      trace: {},
    } as any);
    const coordinator = new AegisEntryCoordinator();
    const result = await coordinator.evaluate({
      context,
      side: 'LONG',
      policy,
      captureDecision: capture,
    });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(result.blackBoxSnapshot).toEqual({ schema: 'MARKET_SNAPSHOT_V1' });
    expect(result.entryDecision).toBeDefined();
    expect(result.safetyConsensus).toBeDefined();
  });

  it('returns the guard decision and derived safety consensus without execution', async () => {
    const entryDecision = {
      finalDecision: 'ALLOW',
      finalReason: 'all_enforced_guards_allowed',
      allowed: true,
      shouldOpen: true,
      finalStrategy: 'aegis_turbo',
      strategy: 'aegis_turbo',
      strategyCandidates: {},
      guards: [],
      trace: {} as any,
      metadata: {},
      warnings: [],
      adjustedLeverage: 15,
      adjustedPositionFraction: 0.08,
      decisions: {},
    } as any;
    const evaluate = vi
      .spyOn(AegisEntryGuardOrchestrator, 'evaluate')
      .mockResolvedValue(entryDecision);

    const result = await new AegisEntryCoordinator().decide({ context, side: 'LONG', policy });

    expect(evaluate).toHaveBeenCalledWith(context, policy);
    expect(result).toEqual({
      entryDecision,
      safetyConsensus: expect.objectContaining({
        allowed: true,
        reason: 'entry_safety_consensus_disabled',
      }),
    });
    expect(result.entryDecision.adjustedLeverage).toBe(15);
    expect(result.entryDecision.adjustedPositionFraction).toBe(0.08);
  });
});
