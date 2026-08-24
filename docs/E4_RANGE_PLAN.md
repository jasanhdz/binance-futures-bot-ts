# E4 Range — Sistema de Trading en Rangos Laterales

**Fecha:** 2026-08-24
**Estado:** Plan aprobado, pendiente de implementación
**Objetivo:** Detectar mercados laterales seguros, operar en soporte/resistencia, cerrar cuando se rompa el rango.

---

## 1. Resumen Ejecutivo

### Problema
El sistema actual (E4 Turbo/Momentum) solo funciona en mercados con tendencia clara. Cuando el mercado está lateralizado (CHOP), el cerebro dice HOLD y el bot no opera. Esto significa **días sin actividad** y oportunidades perdidas en rangos.

### Solución
Crear un sistema paralelo que detecte rangos laterales seguros y opere comprando en soporte y vendiendo en resistencia, con detección automática de rupturas.

### Beneficio esperado
- Operar en mercados que el sistema actual ignora
- Generar ingresos en periodos de lateralización
- Complementar el sistema turbo/momentum existente

---

## 2. Diseño del Algoritmo

### 2.1 Detección de Rango

**Indicadores:**
- Bollinger Bands Width < 0.06 (compresión)
- ATR Percentile < 30 (volatilidad baja)
- ADX < 25 (sin tendencia)
- Oscilación del precio > 2% (amplitud mínima)

**Criterio de "rango seguro":**
- 3 de 4 indicadores deben cumplirse
- Mínimo 2 toques en soporte y 2 en resistencia
- Duración mínima del rango: 4-6 horas
- Tail risk < 0.40

### 2.2 Identificación de Soporte y Resistencia

**Métodos:**
1. Encontrar máximos y mínimos locales (window=5)
2. Agrupar niveles similares (tolerancia 0.5%)
3. Contar toques en cada nivel
4. Filtrar niveles con al menos 2 toques
5. Verificar amplitud mínima (2%)

### 2.3 Evaluación de Seguridad

**Condiciones para operar:**
- Rango válido confirmado
- Tail risk < 0.40
- Precio dentro del rango
- Volumen no muy bajo (ratio > 0.5)
- Sin evento de riesgo (RISK_OFF)

### 2.4 Señales de Entrada

| Condición | Acción |
|-----------|--------|
| Precio ≤ Soporte × 1.005 AND RSI < 30 | LONG |
| Precio ≥ Resistencia × 0.995 AND RSI > 70 | SHORT |

**Parámetros:**
- RSI oversold: 30
- RSI overbought: 70
- Tolerancia al nivel: 0.5%
- Requiere vela de rechazo: Sí

### 2.5 Lógica de Salida

| Condición | Acción |
|-----------|--------|
| Take profit en medio del rango | Cerrar con ganancia |
| Stop loss fuera del rango | Cerrar con pérdida |
| Precio cierra fuera del rango (2 velas) | ALERTA + Cierre |
| Volumen spike + breakout | Cierre inmediato |

### 2.6 Detección de Ruptura

**Señales de ruptura:**
- Precio cierra por encima de resistencia (2 velas consecutivas)
- Precio cierra por debajo de soporte (2 velas consecutivas)
- Volumen > 2x promedio
- ATR se expande > 50%

**Urgencia:**
- HIGH: Ruptura con volumen spike
- MEDIUM: Ruptura sin volumen spike

---

## 3. Arquitectura del Sistema

### 3.1 Componentes

| Componente | Archivo | Función |
|------------|---------|---------|
| E4RangeDetector | `src/domain/services/E4RangeDetector.ts` | Detecta si el mercado está en rango |
| E4RangeLevels | `src/domain/services/E4RangeLevels.ts` | Identifica soporte y resistencia |
| E4RangeSafety | `src/domain/services/E4RangeSafety.ts` | Evalúa si es seguro operar |
| E4RangeSignal | `src/domain/services/E4RangeSignal.ts` | Genera señales LONG/SHORT |
| E4RangeBreakout | `src/domain/services/E4RangeBreakout.ts` | Detecta rupturas del rango |
| RangeService | `src/app/services/RangeService.ts` | Orquesta todo el flujo |

### 3.2 Integración con Sistema Actual

**Nuevo modo de símbolo: `RANGE`**

```
processSymbol(symbol) →
  ¿symbolMode == 'OFF'? → Saltar
  ¿symbolMode == 'RANGE'? → processRangeMode (NUEVO)
  ¿symbolMode == 'SHADOW'? → Solo escanear
  ¿symbolMode == 'LIVE'? → Sistema actual (turbo/momentum)
```

**Archivos a modificar:**
- `ConfigLoader.ts` — Agregar `RANGE` a `AegisSymbolMode`
- `TradingService.ts` — Agregar `processRangeMode()` method
- `AegisRegimeGuard.ts` — Agregar `RANGE_BOUND` a los regímenes
- `regime_config.live.yaml` — Agregar config de `e4_range`

### 3.3 Flujo Principal

```
Cada 15 minutos (por símbolo en modo RANGE):

1. E4RangeDetector.detectRange(candles)
   → { isRangeBound, confidence }

2. E4RangeLevels.findSupportResistance(candles)
   → { support, resistance, valid }

3. E4RangeSafety.evaluateSafety(rangeData, marketData)
   → { isSafe, reason }

4. E4RangeSignal.generateEntrySignal(price, rsi, rangeData)
   → { signal: LONG/SHORT/NONE }

5. Si hay posición abierta:
   E4RangeBreakout.detectBreakout(recentCandles, rangeData)
   → { isBreaking, urgency }
```

---

## 4. Configuración

### 4.1 regime_config.live.yaml (agregar)

```yaml
aegis:
  e4_range:
    enabled: true
    mode: SHADOW  # Empezar SHADOW, luego ENFORCE

    detection:
      max_bb_width: 0.06
      max_adx: 25
      min_range_amplitude_pct: 2.0
      min_touches: 2
      min_range_duration_hours: 4

    entry:
      rsi_oversold: 30
      rsi_overbought: 70
      volume_threshold: 1.5
      require_rejection_candle: true

    exit:
      take_profit_mid_range: true
      stop_loss_beyond_range: true
      breakout_close: true
      breakout_alert: true

    risk:
      max_leverage: 10
      position_fraction: 0.15
      max_hold_hours: 24
```

### 4.2 Símbolos para range trading

Todos los 11 símbolos:
- BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT
- DOGEUSDT, ADAUSDT, AVAXUSDT, LINKUSDT, SUIUSDT, LTCUSDT

---

## 5. Plan de Implementación

### Fase 1: Implementación Base (Días 1-2)

1. Crear `E4RangeDetector.ts`
   - Algoritmo de detección de rangos
   - Bollinger Bands Width
   - ATR Percentile
   - ADX
   - Oscilación del precio

2. Crear `E4RangeLevels.ts`
   - Detección de máximos/mínimos locales
   - Agrupación de niveles
   - Conteo de toques
   - Validación de amplitud

3. Escribir tests para ambos componentes

### Fase 2: Lógica de Trading (Días 3-4)

4. Crear `E4RangeSafety.ts`
   - Evaluación de seguridad
   - Verificación de tail risk
   - Verificación de posición del precio

5. Crear `E4RangeSignal.ts`
   - Generación de señales LONG/SHORT
   - Cálculo de entry price, stop loss, take profit

6. Crear `E4RangeBreakout.ts`
   - Detección de rupturas
   - Clasificación de urgencia

7. Escribir tests para ambos componentes

### Fase 3: Integración (Días 5-6)

8. Crear `RangeService.ts`
   - Orquestador del flujo
   - Conexión con TradingService

9. Modificar `ConfigLoader.ts`
   - Agregar modo RANGE

10. Modificar `TradingService.ts`
    - Agregar `processRangeMode()`

11. Modificar `regime_config.live.yaml`
    - Agregar configuración de e4_range

### Fase 4: Backtesting (Días 7-8)

12. Crear `src/tools/range_backtester.ts`
    - Herramienta de backtesting
    - Recopilación de métricas

13. Ejecutar backtests
    - 30 días de datos
    - 11 símbolos
    - Métricas: win rate, profit factor, drawdown

### Fase 5: Análisis y Decisión (Día 9)

14. Analizar resultados
    - Comparar con sistema actual
    - Identificar mejores símbolos
    - Ajustar parámetros

15. Decidir si implementar en live

---

## 6. Métricas de Éxito

| Métrica | Objetivo |
|---------|----------|
| Win rate | > 55% |
| Profit factor | > 1.5 |
| Maximum drawdown | < 10% |
| Sharpe ratio | > 1.0 |
| Trades por semana | 5-10 por símbolo |

---

## 7. Riesgos y Mitigaciones

| Riesgo | Mitigación |
|--------|------------|
| Falsos rangos | Requerir 2+ toques y duración mínima |
| Rupturas tardías | Detección de ruptura con 2 velas confirmadas |
| Baja liquidez | Verificar volumen antes de entrar |
| Eventos de riesgo | Tail risk filter < 0.40 |
| Over-trading | Max 1 posición por símbolo, max hold 24h |

---

## 8. Comparación con Sistema Actual

| Aspecto | E4 Turbo/Momentum | E4 Range |
|---------|-------------------|----------|
| Mercado ideal | Tendencia clara | Lateralización |
| Señales | Brain + guards | S/R + RSI + Volume |
| Duración trades | Minutos a horas | Horas a días |
| Trailing stop | Sí | No (TP fijo en medio del rango) |
| Break-even | Sí | No |
| Detección de salida | Exit eye + trailing | Ruptura del rango |

---

## 9. Próximos Pasos

1. **Aprobación del plan** — Usuario aprueba este documento
2. **Implementación** — Seguir el plan fase por fase
3. **Testing** — Tests unitarios para cada componente
4. **Backtesting** — Probar en datos históricos
5. **Decisión** — Si los resultados son positivos, implementar en live

---

## 10. Archivos Relacionados

- `src/domain/services/E4RangeDetector.ts` (NUEVO)
- `src/domain/services/E4RangeLevels.ts` (NUEVO)
- `src/domain/services/E4RangeSafety.ts` (NUEVO)
- `src/domain/services/E4RangeSignal.ts` (NUEVO)
- `src/domain/services/E4RangeBreakout.ts` (NUEVO)
- `src/app/services/RangeService.ts` (NUEVO)
- `src/tools/range_backtester.ts` (NUEVO)
- `src/infra/config/ConfigLoader.ts` (MODIFICAR)
- `src/app/services/TradingService.ts` (MODIFICAR)
- `src/domain/services/AegisRegimeGuard.ts` (MODIFICAR)
- `regime_config.live.yaml` (MODIFICAR)
