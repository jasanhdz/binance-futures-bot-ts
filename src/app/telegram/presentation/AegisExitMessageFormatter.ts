import type { BotState, Side } from '../../../core/types';

export interface AegisExitDescription {
  emoji: string;
  title: string;
  reason: string;
  canonicalExitType: string;
  displayExitLabel: string;
  labelMismatch: boolean;
  mismatchReason?: string;
}

export interface AegisExitDescriptionInput {
  reason: string;
  pnl?: number;
  botState: Pick<
    BotState,
    | 'lastEntryPrice'
    | 'lastLeverage'
    | 'lastActualLeverage'
    | 'lastStopRoe'
    | 'lastTakeProfitRoe'
    | 'lastTrailStop'
  >;
  side: Side;
  exitPrice: number;
  computeBracketPrice: (
    side: Side,
    entryPrice: number,
    roe: number,
    leverage: number,
    type: 'STOP' | 'TP',
  ) => number;
}

export function formatScore(value?: number): string {
  const score = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `${(score * 100).toFixed(1)}%`;
}

export function formatRoe(value: number): string {
  const roe = Number.isFinite(value) ? value * 100 : 0;
  return `${roe >= 0 ? '+' : ''}${roe.toFixed(2)}% ROE`;
}

export function formatSignedUsd(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return safe >= 0 ? `+$${safe.toFixed(2)}` : `-$${Math.abs(safe).toFixed(2)}`;
}

export function describeAegisExit(input: AegisExitDescriptionInput): AegisExitDescription {
  const { reason, pnl, botState, side, exitPrice, computeBracketPrice } = input;
  const normalized = String(reason || '').toUpperCase();
  const build = (
    emoji: string,
    canonicalExitType: string,
    detail: string,
    displayExitLabel = canonicalExitType,
    mismatchReason?: string,
  ): AegisExitDescription => ({
    emoji,
    title: displayExitLabel,
    reason: detail,
    canonicalExitType,
    displayExitLabel,
    labelMismatch: Boolean(mismatchReason),
    mismatchReason,
  });

  if (normalized.includes('AEGIS_EXIT_EYE_OPPOSITE_SIGNAL')) {
    return build('👁️', 'EXIT_EYE_OPPOSITE_SIGNAL', 'Cierre por ExitEye: señal opuesta en profit');
  }
  if (normalized.includes('AEGIS_EXIT_EYE_NEUTRAL_DECAY')) {
    return build(
      '👁️',
      'EXIT_EYE_NEUTRAL_DECAY',
      'Cierre por ExitEye: pérdida de momentum en profit',
    );
  }
  if (normalized.includes('AEGIS_EXIT_EYE_PROTECT_PROFIT')) {
    return build(
      '👁️',
      'EXIT_EYE_PROTECT_PROFIT',
      'Cierre/protección por ExitEye: protección de ganancia',
    );
  }
  if (normalized.includes('TIME_LIMIT')) {
    return build('⏰', 'TIME_LIMIT_EXIT', 'Cierre por límite de tiempo con posición en ganancia');
  }
  if (normalized.includes('BREAK') || normalized.includes('BE_')) {
    return build('🟰', 'BREAK_EVEN_EXIT', 'Cierre por protección de break even');
  }
  if (normalized.includes('TRAIL') || normalized.includes('CALLBACK')) {
    return build('🛡️', 'TRAILING_STOP_EXIT', `Cierre por trailing/callback (${reason})`);
  }
  if (
    normalized.includes('AI') ||
    normalized.includes('IA') ||
    normalized.includes('GUARDIAN') ||
    normalized.includes('SMART') ||
    normalized.includes('CLOSE')
  ) {
    return build('🤖', 'AI_GUARDIAN_EXIT', `Cierre decidido por IA/guardian (${reason})`);
  }
  if (
    normalized.includes('BRACKET') ||
    normalized.includes('EMERGENCY') ||
    normalized.includes('FAILED')
  ) {
    return build('⚠️', 'RISK_CONTROL_EXIT', `Cierre por control de riesgo (${reason})`);
  }

  const entryPrice = botState.lastEntryPrice || 0;
  const leverage = botState.lastLeverage || botState.lastActualLeverage || 20;
  const stopRoe = botState.lastStopRoe ?? -0.15;
  const takeProfitRoe = botState.lastTakeProfitRoe ?? 0.25;
  const stopPrice =
    entryPrice > 0 ? computeBracketPrice(side, entryPrice, stopRoe, leverage, 'STOP') : undefined;
  const tpPrice =
    entryPrice > 0
      ? computeBracketPrice(side, entryPrice, takeProfitRoe, leverage, 'TP')
      : undefined;
  const near = (target?: number) =>
    typeof target === 'number' && target > 0 && Math.abs(exitPrice - target) / target < 0.004;

  if (near(botState.lastTrailStop)) {
    return build('🛡️', 'TRAILING_STOP_EXIT', 'Cierre por trailing stop ejecutado');
  }
  if (near(tpPrice)) {
    return build('💰', 'TAKE_PROFIT', 'Cierre por take profit', 'TAKE PROFIT (TP)');
  }
  if (near(stopPrice)) {
    return build('💸', 'STOP_LOSS', 'Cierre por stop loss', 'STOP LOSS (SL)');
  }
  if (pnl === undefined) {
    return build(
      '❔',
      'CLOSE_OUTCOME_UNKNOWN',
      'Cierre confirmado, pero el PnL realizado exacto no está disponible',
      'CLOSE OUTCOME UNKNOWN',
    );
  }
  if (pnl >= 0) {
    return build(
      '💰',
      'PROFIT_EXIT_UNCLASSIFIED',
      'Cierre en ganancia; no se pudo distinguir TP/trailing con precisión',
      'TAKE PROFIT (TP)',
    );
  }
  return build(
    '💸',
    'LOSS_EXIT_UNCLASSIFIED',
    'Cierre en pérdida; no se pudo distinguir SL/trailing con precisión',
    'STOP LOSS (SL)',
  );
}
