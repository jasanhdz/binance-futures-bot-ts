import { describe, expect, it } from 'vitest';
import {
  formatAegisTurboEntryMessage,
  formatAegisTurboReason,
} from './AegisTurboEntryMessageFormatter';

function message(
  overrides: Partial<Parameters<typeof formatAegisTurboEntryMessage>[0]> = {},
): string {
  return formatAegisTurboEntryMessage({
    symbol: 'ETHUSDT',
    side: 'LONG',
    entryPrice: 3000,
    quantity: 0.01,
    marginUsed: 2,
    walletFallback: 500,
    account: {
      walletBalance: 575.62,
      equityTotal: 579.12,
      availableBalance: 421.42,
    },
    leverage: 20,
    stopPrice: 2977.5,
    tpPrice: 3037.5,
    turboScore: 0.651,
    threshold: 0.6,
    votes: { long: 2, short: 0, neutral: 1 },
    reason: 'rawrecentlongagreement2of3',
    stopRoe: -0.4,
    takeProfitRoe: 0.5,
    trailingActivationRoe: 0.15,
    trailingCallbackRoe: 0.08,
    pricePrecision: 2,
    quantityPrecision: 3,
    ...overrides,
  });
}

describe('formatAegisTurboEntryMessage', () => {
  it('renders compact Turbo-only entry message with dynamic threshold and account balances', () => {
    const text = message();

    expect(text).not.toContain('PROBABILIDADES IA');
    expect(text).not.toContain('🟢 Long:');
    expect(text).not.toContain('🔴 Short:');
    expect(text).not.toContain('🧘 Idle:');
    expect(text).not.toContain('🚪 Close:');
    expect(text).toContain('Score: 65.1% / 60.0%');
    expect(text).toContain('Motivo: Acuerdo LONG reciente 2/3');
    expect(text).toContain('Wallet: $575.62');
    expect(text).toContain('Equity total: $579.12');
    expect(text).toContain('Disponible: $421.42');
    expect(text).toContain('Salida direccional: L=2 | S=0 | N=1 (estimador único; no consenso)');
    expect(text).not.toContain('Votes:');
    expect(text).toContain('✅ Brackets confirmados');
    expect(text).not.toMatch(/undefined|null|NaN/);
  });

  it('shows N/D when equity and available balance are unavailable', () => {
    const text = message({ account: { walletBalance: 500 } });

    expect(text).toContain('Wallet: $500.00');
    expect(text).toContain('Equity total: N/D');
    expect(text).toContain('Disponible: N/D');
    expect(text).not.toMatch(/undefined|null|NaN/);
  });

  it('shows trailing off without activation and callback lines', () => {
    const text = message({ trailingActivationRoe: 0, trailingCallbackRoe: 0 });

    expect(text).toContain('Trailing: OFF');
    expect(text).not.toContain('Callback:');
  });
});

describe('formatAegisTurboReason', () => {
  it('formats known and compact raw agreement reasons', () => {
    expect(formatAegisTurboReason('raw_recent_long_agreement_2_of_3')).toBe(
      'Acuerdo LONG reciente 2/3',
    );
    expect(formatAegisTurboReason('rawrecentlongagreement2of3')).toBe('Acuerdo LONG reciente 2/3');
    expect(formatAegisTurboReason('raw_recent_short_agreement_2_of_3')).toBe(
      'Acuerdo SHORT reciente 2/3',
    );
  });

  it('formats known gate reasons', () => {
    expect(formatAegisTurboReason('insufficient_recent_model_agreement')).toBe(
      'Sin acuerdo suficiente entre modelos recientes',
    );
    expect(formatAegisTurboReason('short_disabled_in_turbo_v010')).toBe(
      'SHORT detectado, pero deshabilitado por configuración',
    );
    expect(formatAegisTurboReason('stale_turbo_snapshot')).toBe('Snapshot Turbo desactualizado');
    expect(formatAegisTurboReason('turbo_score_below_threshold')).toBe(
      'Score por debajo del threshold',
    );
    expect(formatAegisTurboReason('allowed_aegis_turbo_micro_live')).toBe(
      'Señal aprobada por gate Aegis Turbo',
    );
  });
});
