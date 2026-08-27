# AEGIS Regime Guard

## Objetivo

Regime Guard v1 es el cadenero de Aegis Entry Policy. No predice `LONG` o `SHORT`; decide si el mercado actual es apto para operar la señal que Turbo ya produjo.

La primera versión es heurística y corre en `SHADOW` en live. Su objetivo inmediato es generar evidencia y metadata para entrenar después modelos de régimen globales, calibrados por símbolo o específicos por símbolo.

## Modos

- `OFF`: no participa y no bloquea.
- `SHADOW`: evalúa, marca `wouldBlock`, pero no bloquea la entrada.
- `ENFORCE`: puede devolver `DENY` antes de `short_gate`, `entry_quality`, `event_risk`, `decision_brain`, `clean_entry` y `probe_mode`.

Live inicia en:

```yaml
aegis:
  entry_policy:
    guards:
      regime:
        enabled: true
        mode: SHADOW
  regime_guard:
    enabled: true
    mode: SHADOW
    source: HYBRID_HEURISTIC
```

## Labels

- `MOMENTUM_UP`
- `MOMENTUM_DOWN`
- `BREAKOUT_UP`
- `BREAKOUT_DOWN`
- `TREND_UP`
- `TREND_DOWN`
- `CHOP`
- `EXHAUSTION`
- `RISK_OFF`
- `HIGH_VOL_RISK`
- `UNKNOWN`

## Reglas v1

La fuente `HYBRID_HEURISTIC` usa señales ya disponibles:

- `eventRiskMode=RISK_OFF` o `MANUAL_ONLY` => `RISK_OFF`
- `tailRiskScore >= highTailRiskThreshold` => `HIGH_VOL_RISK`
- alt `LONG` con BTC `SHORT` => bloqueo shadow/enforce según modo
- alt `SHORT` con BTC `LONG` => bloqueo shadow/enforce según modo
- BTC/ETH en `HOLD`, contradictorios o no alineados para alts => `CHOP`
- score alto, votos 3/3 y grade `A`/`A_PLUS` sin contradicción BTC/ETH => `MOMENTUM_UP` o `MOMENTUM_DOWN`
- snapshot viejo => `UNKNOWN` con `regime_stale_snapshot`
- falta de información => `UNKNOWN`

Razones estándar:

- `regime_trade_allowed`
- `regime_disabled`
- `regime_shadow_would_block`
- `regime_chop_block`
- `regime_risk_off_block`
- `regime_exhaustion_block`
- `regime_high_vol_risk_block`
- `regime_unknown_block`
- `regime_low_confidence`
- `regime_btc_eth_not_aligned`
- `regime_alt_long_btc_short_block`
- `regime_alt_short_btc_long_block`
- `regime_tail_risk_high`
- `regime_stale_snapshot`
- `regime_model_unavailable`
- `regime_invalid_source`

## ML futuro

`source: ML_MODEL` está reservado. Por ahora no llama a Python y devuelve `regime_model_unavailable`. En `SHADOW` no bloquea; en `ENFORCE` solo bloquearía si `UNKNOWN` está en `block_when`.

Formato previsto:

```json
{
  "symbol": "XRPUSDT",
  "side": "LONG",
  "features": {}
}
```

Respuesta futura:

```json
{
  "symbol": "XRPUSDT",
  "regime": "MOMENTUM_UP",
  "confidence": 0.78,
  "allowed": true,
  "model_scope": "SYMBOL_SPECIFIC",
  "model_version": "regime_v001",
  "reasons": []
}
```

Los scopes previstos son:

- `GLOBAL`
- `SYMBOL_CALIBRATED`
- `SYMBOL_SPECIFIC`

## Decision trace

Ejemplo en `ENTRY_POLICY_DECISION`:

```json
{
  "entryPolicy": {
    "finalDecision": "ALLOW",
    "finalReason": "all_enforced_guards_allowed",
    "regime": {
      "enabled": true,
      "mode": "SHADOW",
      "decision": "SHADOW_DENY",
      "reason": "regime_shadow_would_block",
      "wouldBlock": true,
      "regime": "CHOP",
      "confidence": 0.7,
      "source": "HYBRID_HEURISTIC",
      "btcAction": "SHORT",
      "ethAction": "HOLD"
    }
  }
}
```

El trace completo conserva todos los guards. Si `regime` bloquea en `ENFORCE`, los guards posteriores quedan como `*_not_evaluated`.

## Dataset futuro

La metadata deja listo el dataset de outcome:

- symbol, side, timestamp
- turboScore, votes, setupGrade
- regime label, confidence, reason, source
- btcAction/btcScore, ethAction/ethScore
- entryQualityScore, tailRiskScore
- eventRiskMode
- finalDecision, finalReason

Momentum Guard no está implementado en esta fase. Regime Guard solo decide aptitud de mercado; Momentum Guard futuro decidirá si conviene acompañar o extender momentum dentro de un régimen apto.
