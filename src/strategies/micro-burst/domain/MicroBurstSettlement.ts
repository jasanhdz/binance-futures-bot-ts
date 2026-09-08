export interface MicroBurstSettlementIdentity {
  tradeId: string;
  episodeId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  policyVersion: 'CONTEXTUAL_V3';
  configHash: string;
  codeCommitSha: string;
  entryOrderId: string;
  closeOrderIds: string[];
  quantity: number;
  openedAtMs: number;
  closedAtMs: number;
}

export interface MicroBurstSettlementFill {
  id: string;
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  eventTimeMs: number;
  realizedPnlUsdt: number;
  commission: number;
  commissionAsset: string;
}

export interface MicroBurstSettlementEvidence {
  source: 'BINANCE_EXACT_ORDERS_TRADES_AND_INCOME_V1';
  observedAtMs: number;
  /** The adapter must establish exhaustive pagination, not merely a nonempty page. */
  fillsComplete: boolean;
  fundingComplete: boolean;
  fundingFromMs: number;
  fundingThroughMs: number;
  /** Exact-order attribution and a fresh flat observation, not a mark-price estimate. */
  exactOrdersFilledAndPositionFlat: boolean;
  fills: MicroBurstSettlementFill[];
  funding: {
    id: string;
    tradeId: string;
    symbol: string;
    asset: string;
    amount: number;
    eventTimeMs: number;
  }[];
}

export type MicroBurstSettlementResult =
  | { status: 'UNVERIFIED'; netPnlUsdt: null; reason: string }
  | {
      status: 'VERIFIED';
      grossPnlUsdt: number;
      commissionsUsdt: number;
      fundingUsdt: number;
      netPnlUsdt: number;
    };

export function validMicroBurstSettlementIdentity(identity: MicroBurstSettlementIdentity): boolean {
  return (
    !!identity &&
    !(
      identity.policyVersion !== 'CONTEXTUAL_V3' ||
      ![identity.tradeId, identity.episodeId, identity.entryOrderId].every(
        (value) => typeof value === 'string' && !!value.trim() && value.length <= 256,
      ) ||
      !/^[A-Z0-9]+$/.test(identity.symbol) ||
      !['LONG', 'SHORT'].includes(identity.side) ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.configHash) ||
      !/^[a-f0-9]{40}$/.test(identity.codeCommitSha) ||
      !Number.isFinite(identity.quantity) ||
      identity.quantity <= 0 ||
      ![identity.openedAtMs, identity.closedAtMs].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) ||
      identity.closedAtMs < identity.openedAtMs ||
      !Array.isArray(identity.closeOrderIds) ||
      !identity.closeOrderIds.length ||
      identity.closeOrderIds.length > 100 ||
      identity.closeOrderIds.some(
        (id) => typeof id !== 'string' || !id.trim() || id.length > 256,
      ) ||
      new Set([identity.entryOrderId, ...identity.closeOrderIds]).size !==
        identity.closeOrderIds.length + 1
    )
  );
}

/** Only fully attributed USDT cashflows are labels. Unsupported fee assets stay unknown. */
export function reconcileMicroBurstSettlement(
  identity: MicroBurstSettlementIdentity,
  evidence: MicroBurstSettlementEvidence,
): MicroBurstSettlementResult {
  const fail = (reason: string): MicroBurstSettlementResult => ({
    status: 'UNVERIFIED',
    netPnlUsdt: null,
    reason,
  });
  if (!validMicroBurstSettlementIdentity(identity))
    return fail('MICRO_SETTLEMENT_IDENTITY_INVALID');
  if (
    !evidence ||
    !Number.isSafeInteger(evidence.observedAtMs) ||
    evidence.observedAtMs < identity.closedAtMs ||
    evidence.source !== 'BINANCE_EXACT_ORDERS_TRADES_AND_INCOME_V1' ||
    evidence.fillsComplete !== true ||
    evidence.fundingComplete !== true ||
    evidence.exactOrdersFilledAndPositionFlat !== true ||
    !Number.isSafeInteger(evidence.fundingFromMs) ||
    evidence.fundingFromMs < 0 ||
    evidence.fundingFromMs > identity.openedAtMs ||
    !Number.isSafeInteger(evidence.fundingThroughMs) ||
    evidence.fundingThroughMs < identity.closedAtMs ||
    evidence.fundingThroughMs > evidence.observedAtMs ||
    !Array.isArray(evidence.fills) ||
    !evidence.fills.length ||
    evidence.fills.length > 1000 ||
    !Array.isArray(evidence.funding) ||
    evidence.funding.length > 1000
  )
    return fail('MICRO_SETTLEMENT_COVERAGE_INCOMPLETE');
  const fillIds = new Set<string>();
  const observedOrders = new Set<string>();
  let entryQuantity = 0;
  let closeQuantity = 0;
  let grossPnlUsdt = 0;
  let commissionsUsdt = 0;
  let fundingUsdt = 0;
  for (const fill of evidence.fills) {
    if (!fill) return fail('MICRO_SETTLEMENT_FILL_UNVERIFIED');
    const entry = fill.orderId === identity.entryOrderId;
    const expectedSide = (identity.side === 'LONG') === entry ? 'BUY' : 'SELL';
    if (
      typeof fill.id !== 'string' ||
      !fill.id.trim() ||
      fillIds.has(fill.id) ||
      fill.symbol !== identity.symbol ||
      fill.side !== expectedSide ||
      (!entry && !identity.closeOrderIds.includes(fill.orderId)) ||
      !Number.isSafeInteger(fill.eventTimeMs) ||
      fill.eventTimeMs < identity.openedAtMs ||
      fill.eventTimeMs > identity.closedAtMs ||
      ![fill.quantity, fill.price, fill.realizedPnlUsdt, fill.commission].every(Number.isFinite) ||
      fill.quantity <= 0 ||
      fill.price <= 0 ||
      fill.commission < 0 ||
      fill.commissionAsset !== 'USDT' ||
      (entry && fill.realizedPnlUsdt !== 0)
    )
      return fail('MICRO_SETTLEMENT_FILL_UNVERIFIED');
    fillIds.add(fill.id);
    observedOrders.add(fill.orderId);
    if (entry) entryQuantity += fill.quantity;
    else closeQuantity += fill.quantity;
    grossPnlUsdt += fill.realizedPnlUsdt;
    commissionsUsdt += fill.commission;
  }
  const tolerance =
    Number.EPSILON *
    Math.max(identity.quantity, entryQuantity, closeQuantity) *
    evidence.fills.length *
    4;
  if (
    ![entryQuantity, closeQuantity].every(Number.isFinite) ||
    Math.abs(entryQuantity - identity.quantity) > tolerance ||
    Math.abs(closeQuantity - identity.quantity) > tolerance ||
    observedOrders.size !== identity.closeOrderIds.length + 1
  )
    return fail('MICRO_SETTLEMENT_QUANTITY_INCOMPLETE');
  const fundingIds = new Set<string>();
  for (const funding of evidence.funding) {
    if (
      !funding ||
      typeof funding.id !== 'string' ||
      !funding.id.trim() ||
      fundingIds.has(funding.id) ||
      funding.tradeId !== identity.tradeId ||
      funding.symbol !== identity.symbol ||
      funding.asset !== 'USDT' ||
      !Number.isFinite(funding.amount) ||
      !Number.isSafeInteger(funding.eventTimeMs) ||
      funding.eventTimeMs < identity.openedAtMs ||
      funding.eventTimeMs > identity.closedAtMs
    )
      return fail('MICRO_SETTLEMENT_FUNDING_UNVERIFIED');
    fundingIds.add(funding.id);
    fundingUsdt += funding.amount;
  }
  const netPnlUsdt = grossPnlUsdt - commissionsUsdt + fundingUsdt;
  if (![grossPnlUsdt, commissionsUsdt, fundingUsdt, netPnlUsdt].every(Number.isFinite))
    return fail('MICRO_SETTLEMENT_NONFINITE');
  return { status: 'VERIFIED', grossPnlUsdt, commissionsUsdt, fundingUsdt, netPnlUsdt };
}
