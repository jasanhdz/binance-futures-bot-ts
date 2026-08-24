# Aegis Range Strategy V1

**Fecha:** 2026-08-24

**Estado:** Plan revisado y aprobado para preregistro; implementación pendiente

**Fase autorizada inicialmente:** `RESEARCH_ONLY`

**Objetivo:** Evaluar si los rechazos causales en soportes y resistencias de rangos laterales operables producen expectativa neta positiva después de costos.

## 1. Decisiones Inmutables

### 1.1 Nombre y separación de responsabilidades

La estrategia se llama **Aegis Range Strategy V1**. Sus componentes de investigación usan nombres como `RangeDetectorV1`, `RangeLevelsV1`, `RangeSignalV1` y `RangeBreakoutV1`.

El nombre E4 queda reservado exclusivamente para el Tail Risk Guard existente:

- Guard: `e4_tail_risk`
- Endpoint: `/ml-v2/e4_tail_risk`
- Modelo: `E4_V1_FROZEN`
- Threshold congelado: `0.4522452210875323`

Range no puede modificar el modelo, threshold, `FeatureBridge`, API, precompute, adapter, decisiones ni evidencia de E4. Cuando Range eventualmente genere una oportunidad, el E4 Tail Risk Guard existente evaluará ese lado y conservará autoridad para bloquearlo.

### 1.2 Autoridad operacional y estrategia son dimensiones separadas

`AegisSymbolMode` permanece exactamente:

```typescript
type AegisSymbolMode = 'OFF' | 'SHADOW' | 'LIVE';
```

No se añadirá `RANGE`. El modo responde **si el símbolo puede operar**; el router de estrategia responderá **qué estrategia corresponde al estado de mercado**.

```text
                 SYMBOL MODE
          OFF / SHADOW / LIVE
                    |
                    v
               Market State
                    |
          +---------+---------+
          |         |         |
          v         v         v
      MOMENTUM    RANGE     UNSAFE
          |         |
          v         v
      estrategia  Aegis Range
       existente  Strategy V1
          |         |
          +----+----+
               |
               v
        E4 Tail Risk frozen
               |
               v
          Hard Safety
               |
               v
       Approval Boundary
               |
               v
       ejecución existente
```

La integración operacional de este router no pertenece a `RESEARCH_ONLY`.

### 1.3 Motor de régimen autorizado

Range reutilizará conceptualmente `RegimeEngineV2`. No se añadirá `RANGE_BOUND` al guard legacy `AegisRegimeGuard`.

`RegimeEngineV2` ya expone, entre otros:

- `ADX` y pendiente de ADX
- Choppiness y `chopRisk`
- Percentil de ATR
- Percentil del ancho de Bollinger
- Volume ratio
- Estructura de mercado
- Range breakout
- Failed breakouts
- Compresión previa al breakout
- Breakout follow-through
- Transition risk
- Régimen `ACCUMULATION_RANGE`

La clasificación actual de `ACCUMULATION_RANGE` ocurre cuando:

```text
chopRisk >= 0.62
AND structure == MIXED
AND bollingerWidthPercentile < 0.45
```

`CHOP` no equivale a rango seguro. `ACCUMULATION_RANGE` o un contexto no tendencial solo crean un **candidato**; `RangeDetectorV1` debe demostrar además que existen niveles causales, repetibles y operables.

## 2. Hipótesis Preregistrada

### 2.1 Hipótesis principal

> Cuando `RegimeEngineV2` identifica un entorno no tendencial y existe un rango causalmente confirmado con soporte y resistencia repetidos, comprar un rechazo cerca del soporte y vender un rechazo cerca de la resistencia produce expectativa neta positiva después de costos.

### 2.2 Flujo experimental

```text
Closed candles
      |
      v
RegimeEngineV2
      |
      v
RangeDetectorV1
      |
      v
RangeLevelsV1
      |
      v
RangeSafetyV1
      |
      v
RangeSignalV1
      |
      v
Historical outcome
```

La primera investigación no modificará `TradingService`, ejecución, órdenes, leverage, sizing, brackets, `AegisSymbolMode` ni `regime_config.live.yaml`.

## 3. Invariantes de Causalidad

Estas reglas son hard blockers del experimento, no factores de confianza:

1. Solo se usan velas cerradas disponibles en `decision_at`.
2. Ningún indicador, nivel, régimen o etiqueta puede usar datos posteriores a `decision_at`.
3. Cada pivot o extremo local debe almacenar `pivot_at` y `available_at`.
4. Para un pivot con `L` velas a la izquierda y `R` a la derecha, el pivot en `T` solo está disponible después del cierre de `T + R`.
5. Al construir niveles en `T`, solo pueden utilizarse pivots con `available_at <= T`.
6. El rango se reconstruye en cada `T` con la información disponible hasta `T`; está prohibido descubrir un rango retrospectivamente y simular entradas anteriores a su confirmación.
7. Una vela de rechazo debe estar cerrada antes de emitir la señal.
8. La entrada histórica se ejecuta en `NEXT_BAR_OPEN`, incluyendo costos y slippage configurados.
9. Un breakout de dos cierres solo se confirma al terminar el segundo cierre; la salida histórica se ejecuta en `NEXT_BAR_OPEN`.
10. El volumen completo de una vela OHLCV solo está disponible al cierre. No se simulan cierres intrabar con volumen final conocido retrospectivamente.
11. Una variante futura basada en eventos o WebSocket será un experimento separado y no se mezclará con el backtest OHLCV.
12. Al abrir una operación se congela la tesis del rango; ningún recálculo posterior puede ensanchar el stop o mejorar retrospectivamente el target.

### 3.1 Snapshot congelado de entrada

Cada operación de investigación almacenará como mínimo:

```text
range_id
decision_at
entry_available_at
support_at_entry
resistance_at_entry
midpoint_at_entry
range_confirmed_at
stop_at_entry
target_at_entry
regime_at_entry
range_confidence_at_entry
tail_risk_score_at_entry
thesis_feature_hash
```

## 4. Componentes Research-Only

### 4.1 `RangeDetectorV1`

Responsabilidades:

- Consumir velas cerradas y el snapshot causal de `RegimeEngineV2`.
- Distinguir `RANGE_CANDIDATE`, `OPERABLE_RANGE` y `NOT_OPERABLE`.
- Separar invariantes obligatorios de un score descriptivo de confianza.
- Rechazar contextos con breakout activo, transition risk incompatible, historia insuficiente o niveles no confirmados.

No usará una regla ciega de “3 de 4”. Los requisitos estructurales son hard blockers; los indicadores auxiliares solo pueden contribuir a confianza o segmentación.

### 4.2 `RangeLevelsV1`

Responsabilidades:

- Crear pivots causales con `pivot_at` y `available_at`.
- Agrupar niveles compatibles sin utilizar información futura.
- Contar toques confirmados y rechazos por lado.
- Estimar soporte, resistencia, midpoint, amplitud y antigüedad.
- Generar un `range_id` determinista y auditable.

La primera variante propuesta para investigación puede usar `L=2, R=2`, pero ese valor deberá quedar preregistrado antes de abrir `VALIDATION`. Un pivot en `T` no existe para el algoritmo hasta `T+2`.

### 4.3 `RangeSafetyV1`

Responsabilidades:

- Confirmar que el candidato posee soporte y resistencia repetibles.
- Diferenciar `CHOP` desordenado de rango operable.
- Rechazar niveles demasiado estrechos después de costos.
- Rechazar breakouts, alta transición, datos incompletos y políticas de riesgo incumplidas.
- Aplicar la política Range de tail risk sin modificar E4.

### 4.4 `RangeSignalV1`

Responsabilidades:

- Emitir `LONG`, `SHORT` o `NONE` después del cierre de una vela de rechazo.
- Registrar `decision_at` y ordenar ejecución simulada en `NEXT_BAR_OPEN`.
- Congelar el snapshot de tesis al entrar.
- Mantener LONG y SHORT como cohortes separadas.

Definición inicial que debe formalizarse en R0:

- Rechazo LONG: la vela toca o penetra la zona causal de soporte y cierra nuevamente dentro del rango.
- Rechazo SHORT: la vela toca o penetra la zona causal de resistencia y cierra nuevamente dentro del rango.

Los requisitos de cuerpo, wick, distancia al nivel, RSI u otras confirmaciones no se asumirán como definitivos hasta preregistrarlos.

### 4.5 `RangeBreakoutV1`

Responsabilidades:

- Detectar ruptura alcista o bajista respecto al snapshot congelado de la operación.
- Separar breakout confirmado por cierres de breakout asistido por volumen.
- Registrar el momento exacto en que la evidencia queda disponible.
- Simular salida causal en `NEXT_BAR_OPEN`.

Variante OHLCV inicial:

```text
primer cierre fuera del rango
        |
segundo cierre fuera del rango
        |
breakout confirmado al cierre
        |
exit NEXT_BAR_OPEN
```

## 5. Registro de Fórmulas R0

Antes de escribir thresholds definitivos se documentarán y congelarán las fórmulas siguientes. Cada fórmula tendrá versión, lookback, tratamiento de datos insuficientes y timestamp de disponibilidad.

### 5.1 Fórmulas ya disponibles en `RegimeEngineV2`

Se reutilizarán sus implementaciones causales cuando sean adecuadas, sin duplicarlas arbitrariamente:

- ADX de 14 periodos y pendiente de la serie.
- ATR de 14 periodos.
- `atrPercentile`: percentile rank del ATR actual dentro de hasta 120 observaciones recientes.
- Bollinger width de 20 periodos.
- `bollingerWidthPercentile`: percentile rank del ancho actual dentro de hasta 120 observaciones recientes.
- `volumeRatio`: volumen de la vela actual dividido por el promedio de las 20 velas cerradas anteriores.
- Choppiness de 14 periodos.
- Estructura, range breakout, failed breakouts y transition risk existentes.

### 5.2 Fórmulas que deben preregistrarse antes del experimento

- **Range amplitude:** fórmula exacta y denominador (`midpoint`, soporte u otro).
- **Zone tolerance:** distancia permitida alrededor del nivel, preferiblemente normalizada por ATR o precio.
- **Touch:** penetración o aproximación válida, separación temporal mínima y regla para evitar contar varias velas del mismo contacto.
- **Rejection candle:** touch, cierre dentro del rango, cuerpo, wick y momento de disponibilidad.
- **Range duration:** desde qué evento empieza y cómo se trata una actualización de niveles.
- **Range confirmation:** mínimos de toques por lado y orden temporal permitido.
- **False range:** etiqueta causal de fallo usada para evaluación, no para entradas previas.
- **Breakout:** número de cierres, distancia mínima fuera del rango y tratamiento del buffer.
- **Costs:** fees, slippage y funding aplicados por símbolo y periodo.

Ninguna fórmula o threshold puede elegirse observando `VALIDATION` o `HOLDOUT`.

## 6. Políticas y Thresholds Separados

### 6.1 E4 congelado

```text
E4 Tail Risk:
BLOCK si score >= 0.4522452210875323
```

### 6.2 Política Range de tail risk

`range_max_tail_risk_score = 0.40` es una hipótesis/política específica de Range. No reemplaza ni altera el threshold E4. Debe calibrarse solo en `TRAIN/CALIBRATION` y quedar congelada antes de abrir `VALIDATION`.

### 6.3 Volumen

Se prohíbe el ambiguo `volume_threshold`. Se separan:

```yaml
min_safety_volume_ratio: PREREGISTER
min_entry_volume_ratio: PREREGISTER
breakout_volume_ratio: PREREGISTER
```

- `min_safety_volume_ratio`: liquidez/actividad mínima para considerar operable el rango.
- `min_entry_volume_ratio`: confirmación de la vela de entrada, si la investigación demuestra que aporta valor.
- `breakout_volume_ratio`: evidencia de ruptura, independiente de la entrada.

Los valores anteriores `0.5`, `1.5` y `2.0` quedan retirados del plan hasta preregistro y calibración válidos.

## 7. Diseño del Backtest

### 7.1 Alcance

- Los 11 símbolos configurados: BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK, SUI y LTC contra USDT.
- Múltiples meses y regímenes; 30 días solo sirven como smoke test técnico.
- LONG y SHORT evaluados por separado.
- Resultados por símbolo, mes, régimen y partición.
- Retornos normalizados por unit notional durante la investigación de edge.
- Sin leverage ni `position_fraction` operacional en R1/R2.

### 7.2 Particiones cronológicas

```text
HISTORICAL DATA
      |
      +-- TRAIN
      |     descubrimiento y descarte de ideas
      |
      +-- CALIBRATION
      |     elección final de fórmulas y thresholds
      |
      +-- VALIDATION
      |     evaluación única sin retuning
      |
      +-- HOLDOUT
            sellado hasta decisión final
```

Reglas:

1. Tuning solo en `TRAIN` y `CALIBRATION`.
2. Después de abrir `VALIDATION`, no se reajustan parámetros y se vuelve a declarar éxito.
3. `HOLDOUT` permanece sellado hasta que exista una especificación congelada.
4. Se usará block-bootstrap temporal para intervalos de confianza.
5. No se tratarán BTC, ETH y SOL en el mismo instante como observaciones independientes.
6. Las ventanas deberán incluir warmup causal sin filtrar información del futuro.

### 7.3 Modelo de ejecución histórica

- Señal generada únicamente al cierre de la vela.
- Entrada y salida en `NEXT_BAR_OPEN`.
- Fees, slippage y funding explícitos.
- Si stop y target pueden tocarse dentro de la misma vela sin resolución intrabar, usar política conservadora preregistrada.
- No usar el mejor precio de la vela para simular ejecución.
- Registrar operaciones rechazadas y razones de abstención.

## 8. Métricas y Gate de Éxito

### 8.1 Métricas primarias

- Gross expectancy.
- Net expectancy after costs.
- Profit factor.
- Maximum drawdown.
- MFE y MAE.
- CVaR / tail loss.
- Breakout-loss rate.
- False-range rate.
- Estabilidad temporal por mes.
- Consistencia por símbolo y régimen.

### 8.2 Métricas secundarias

- Win rate.
- Sharpe ratio.
- Número de trades.
- Trades por semana.
- Duración media.

No se exige una cuota de operaciones. La abstención es un resultado válido. Un win rate alto no compensa expectativa neta negativa o pérdidas de ruptura desproporcionadas.

### 8.3 Gate primario

La promoción requiere conjuntamente:

1. Expectativa neta positiva después de costos.
2. Profit factor aceptable y estable fuera de muestra.
3. Drawdown y CVaR compatibles con la política de riesgo.
4. Estabilidad temporal; el resultado no puede depender de un solo mes o símbolo.
5. Breakout-loss rate y false-range rate controlados.
6. Evidencia suficiente en `VALIDATION`, seguida de confirmación en `HOLDOUT` sellado.

Los valores numéricos finales del gate deben preregistrarse antes de abrir `VALIDATION`.

## 9. Sizing y Portfolio

El plan retira `position_fraction: 0.15`. El runtime momentum live utiliza normalmente `0.01` y contiene `max_position_fraction: 0.01` en sus safety caps.

La investigación separa dos preguntas:

1. ¿Range posee edge con retornos normalizados por unit notional?
2. Si posee edge, ¿cómo debe dimensionarse dentro del portfolio actual?

Sizing, leverage, correlación, concurrencia y presupuesto de riesgo solo se estudiarán después de congelar y validar el edge. No se autoriza exposición live durante `RESEARCH_ONLY`.

## 10. Fases de Trabajo

### PHASE R0 — Preregistration

- Auditar la rama y commits actuales.
- Documentar fórmulas, lookbacks y timestamps de disponibilidad.
- Definir hard blockers y score descriptivo.
- Definir costos y política de fills ambiguos.
- Definir particiones cronológicas y sellar `HOLDOUT`.
- Preregistrar thresholds candidatos sin mirar `VALIDATION`.

**Entregable:** especificación experimental congelada.

### PHASE R1 — Pure Research

Crear componentes puros y testeables:

```text
RangeDetectorV1.ts
RangeLevelsV1.ts
RangeSafetyV1.ts
RangeSignalV1.ts
RangeBreakoutV1.ts
```

Agregar tests de causalidad, especialmente:

- Un pivot no aparece antes de `available_at`.
- Agregar velas futuras no cambia decisiones históricas ya emitidas.
- El rango no existe antes de `range_confirmed_at`.
- La vela de rechazo genera entrada únicamente en la vela siguiente.
- El segundo cierre de breakout genera salida únicamente en la vela siguiente.
- Los niveles y stops congelados no se ensanchan tras la entrada.

**Prohibido en R1:** modificar runtime live o ejecución.

### PHASE R2 — Backtest

- Crear backtester research-only.
- Ejecutar smoke test de 30 días para validar plumbing.
- Ejecutar experimento completo con múltiples meses y los 11 símbolos.
- Aplicar `TRAIN/CALIBRATION/VALIDATION`; mantener `HOLDOUT` sellado.
- Reportar métricas por lado, símbolo, mes y régimen.

### PHASE R3 — Freeze

Solo si existe edge:

- Congelar fórmulas y thresholds.
- Publicar hashes de configuración y dataset.
- Evaluar `HOLDOUT` una única vez.
- Rechazar la estrategia si no mantiene expectativa, estabilidad y control de cola.

### PHASE R4 — Shadow Integration

Solo después de R3:

- Añadir `aegis.range_strategy` en configuración no-live.
- Añadir routing de estrategia independiente de `AegisSymbolMode`.
- Reutilizar `RegimeEngineV2`.
- Pasar oportunidades por E4 Tail Risk congelado y hard safety.
- Emitir telemetría y decisiones SHADOW sin órdenes ni cambios de ejecución.

### PHASE R5 — Evidencia Prospectiva

- Ejecutar shadow prospectivo durante una ventana preregistrada.
- Comparar señales, fills simulados, costos y rupturas con el backtest.
- No retocar parámetros durante la ventana.

Solo después de evidencia prospectiva suficiente podrá proponerse una integración operacional controlada. Esa propuesta requerirá revisión y aprobación separadas.

## 11. Arquitectura Objetivo Posterior a Research

```text
                     Market candles
                           |
                           v
                    RegimeEngineV2
                           |
              +------------+------------+
              |                         |
       Momentum environment       Range candidate
              |                         |
              v                         v
       existing strategy         RangeDetectorV1
                                        |
                                 RangeLevelsV1
                                        |
                                 RangeSafetyV1
                                        |
                                 RangeSignalV1
                                        |
                            LONG / SHORT / NONE
                                        |
              +-------------------------+
              v
          E4 Tail Risk
       FROZEN, SIN CAMBIOS
              |
          ALLOW/BLOCK
              |
              v
         hard safety
              |
              v
      approval boundary
              |
              v
    existing execution path
```

Esta arquitectura es un objetivo condicionado a R0-R5; no autoriza implementación live.

## 12. Archivos Autorizados en la Primera Implementación

La fase `RESEARCH_ONLY` podrá crear nombres equivalentes a:

- `src/domain/services/range-v1/RangeDetectorV1.ts`
- `src/domain/services/range-v1/RangeLevelsV1.ts`
- `src/domain/services/range-v1/RangeSafetyV1.ts`
- `src/domain/services/range-v1/RangeSignalV1.ts`
- `src/domain/services/range-v1/RangeBreakoutV1.ts`
- Tests colocados junto a cada componente.
- Un backtester y utilidades research-only bajo `src/tools/` o un directorio de investigación dedicado.
- Documentación de preregistro, dataset y resultados.

No están autorizados en R0-R2:

- `TradingService.ts`
- Ejecución u órdenes
- Leverage o sizing live
- Brackets
- `AegisSymbolMode`
- `AegisRegimeGuard.ts`
- `regime_config.live.yaml`
- E4 Tail Risk, su threshold o su infraestructura
- Deploy o procesos PM2

## 13. Entregables de la Primera Ejecución

Antes de ejecutar el experimento completo, entregar:

1. Archivos creados.
2. Fórmulas exactas y lookbacks.
3. Invariantes causales y timestamps de disponibilidad.
4. Tests unitarios y de no-look-ahead.
5. Diseño de dataset, particiones y costos.
6. Diseño del backtest y política de fills.
7. Inconsistencias encontradas en código o datos.
8. Diff que confirme que producción no fue modificada.

## 14. Prompt de Implementación Research-Only

```text
Revisa la rama y los commits actuales antes de cambiar código. Vamos a iniciar Aegis Range Strategy V1, NO "E4 Range".

E4 significa exclusivamente el Tail Risk Guard congelado existente (e4_tail_risk, threshold 0.4522452210875323). No modificar su modelo, threshold, FeatureBridge, API, precompute, adapter ni decisiones.

Implementa únicamente la fase RESEARCH_ONLY de Range. No modificar todavía TradingService, ejecución, órdenes, leverage, sizing, brackets, AegisSymbolMode, AegisRegimeGuard ni regime_config.live.yaml.

Reutiliza conceptualmente RegimeEngineV2, que ya dispone de ACCUMULATION_RANGE, CHOP, ADX, choppiness, ATR percentile, Bollinger width percentile, volume ratio, range breakout, failed breakouts y transition risk. No añadir RANGE_BOUND al legacy AegisRegimeGuard.

Crear componentes puros y testeables: RangeDetectorV1, RangeLevelsV1, RangeSafetyV1, RangeSignalV1, RangeBreakoutV1 y un backtester research-only.

Requisitos estrictos de causalidad:
- usar exclusivamente candles cerradas disponibles en decision_at;
- ningún indicador puede usar datos posteriores a decision_at;
- pivots/local extrema deben tener available_at explícito;
- si se usan pivots L/R, el pivot solo existe después de cerrar los R candles posteriores;
- al construir niveles en T solo pueden utilizarse pivots con available_at <= T;
- nunca detectar un rango utilizando su historia futura y luego backtestear entradas anteriores dentro de ese rango;
- rejection candle debe cerrar antes de generar señal;
- entrada histórica = NEXT_BAR_OPEN;
- confirmación de breakout por dos cierres solo está disponible después del segundo cierre; exit histórico = NEXT_BAR_OPEN;
- congelar range_id, support, resistance, midpoint y thesis snapshot al abrir una operación; no ensanchar retrospectivamente SL o rango.

Antes de codificar thresholds definitivos, documenta exactamente las fórmulas de BB width, ATR percentile/lookback, ADX, range amplitude, touches, rejection candle, volume ratio y breakout.

No usar 3 of 4 ciegamente para condiciones que deban ser hard blockers. Separa invariantes del rango de los scores de confianza.

Tratar range_max_tail_risk_score=0.40 como hipótesis/policy específica de Range. No alterar el threshold E4 congelado.

Separar min_safety_volume_ratio, min_entry_volume_ratio y breakout_volume_ratio. No seleccionar valores mirando VALIDATION.

El backtest de 30 días será solo smoke test. Diseñar el experimento final con particiones cronológicas TRAIN / CALIBRATION / VALIDATION y HOLDOUT sellado; tuning solo en TRAIN/CALIBRATION. Después de abrir VALIDATION/HOLDOUT no reajustar parámetros y volver a declarar éxito.

Evaluar los 11 símbolos, LONG/SHORT por separado, por mes y por régimen. Métricas primarias: net expectancy after costs, profit factor, drawdown, MFE/MAE, tail/CVaR y estabilidad temporal. Win rate y trades/week son secundarios, nunca cuotas obligatorias.

No implementar live ni tocar producción en esta fase. Al terminar entrega: archivos creados, fórmulas exactas, causal invariants, tests, diseño del dataset/backtest y cualquier inconsistencia encontrada antes de ejecutar el experimento.
```
