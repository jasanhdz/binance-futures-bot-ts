# Auditoria contrafactual de regresion de probabilidades Aegis

Fecha: 2026-09-02

## Veredicto ejecutivo

No se encontro evidencia de que Micro Burst, el transporte directo de contexto WebSocket TypeScript -> Python, los cambios posteriores del runtime Aegis o el cambio de scikit-learn `1.7.2` a `1.8.0` hayan deteriorado las features, probabilidades, scores o decisiones del Current Brain.

El replay determinista produjo coincidencia exacta en las 220 filas comparadas entre el baseline Python anterior al contexto directo, el primer commit que consumio ese contexto y el runtime actual. La maxima diferencia numerica absoluta fue `0.0` en probabilidades, raw score y calibrated score. Los hashes de features, sides, selecciones, decisiones y veredictos tambien coincidieron sin excepciones.

La probabilidad direccional base constante observada en el fixture no fue introducida por las mejoras recientes: ya existia en el baseline del 26 de agosto. Las 220 entradas produjeron 220 vectores de features distintos y 220 scores economicos calibrados distintos. El Current Brain tomo dos estados de decision distintos sobre esas filas.

El log completo observado del 2 de septiembre tambien demuestra que el runtime no permanece indefinidamente en `HOLD/1.000`: entre `00:00:00.264Z` y `16:11:28.002Z` contiene 483 selecciones direccionales confirmadas y 17 valores validos distintos de `turboRawScore`. Esta observacion respalda el replay, pero no se usa como sustituto de la comparacion contrafactual porque las filas del log pueden incluir respuestas repetidas o cacheadas.

## Alcance y seguridad

La auditoria fue offline y read-only respecto del sistema operativo de trading. No se modificaron configuraciones YAML, `.env`, modelos, artefactos, features, thresholds, riesgo ni autoridad LIVE. No se reiniciaron procesos PM2, no se enviaron ordenes y no se realizaron mutaciones Binance. Micro Burst permanecio en `SHADOW` con `liveExecution=false`.

El harness y este informe se dejaron sin commit.

## Revisiones comparadas

| Limite | Repositorio | Commit | Fecha | Proposito |
|---|---|---|---|---|
| Baseline Python pre-contexto | Python | `eab51262e7a54a09d479e6672475476565cd1dab` | 2026-08-26 | Runtime anterior al parser y consumo de contexto TypeScript |
| Integracion Python | Python | `ba0ade192ddf7ff84889c054e94f7fe231da6f8c` | 2026-08-30 | Consume contexto WebSocket TypeScript |
| Runtime actual auditado | Python | `1be2a02b24cc0a82f68602d28948b03acb13400b` | 2026-09-01 | Estado actual y pin declarado de sklearn |
| Limite TS pre-Micro | TypeScript | `9af71335f015bff0393e93d17d54f79279597c2f` | 2026-08-27 | Ultimo commit anterior al wiring operacional |
| Wiring Micro Burst | TypeScript | `3aa319a949c3cfc82ce742796ab4f120aaf73314` | 2026-08-27 | Integra Micro Burst operacional en SHADOW |
| Transporte inicial TS | TypeScript | `16a311372ff92b815007863b5740a6c85d25a603` | 2026-08-29 | Transporta market context WebSocket a Aegis |
| Fix de frescura desplegado | TypeScript | `524dbedcd04839bdd0b4272831e308181716df8b` | 2026-09-02 | Separa salud de transporte y frescura de velas |

El diff `9af7133..3aa319a` incorpora Micro Burst, su journal, tests, wiring en `TradingService` y adaptadores de frontera. No modifica los modulos TypeScript de contexto o cliente Aegis, que se incorporaron posteriormente. La comparacion Python usa ademas un commit del 26 de agosto, anterior al wiring Micro Burst, y obtiene resultados exactos frente al runtime actual.

## Metodologia

Se creo `scripts/audit_aegis_probability_regression.py` en el repositorio Python. El harness:

1. Genera 20 variantes deterministas de un snapshot con los 11 simbolos canonicos.
2. Construye 96 velas cerradas de cinco minutos por simbolo.
3. Ejecuta `CurrentBrainEngine.evaluate_replay` sin red ni exchange.
4. Conserva el mismo artefacto del modelo para aislar cambios de codigo y runtime.
5. Captura 220 filas por revision, una por variante y simbolo.
6. Registra hashes de vector y valores de features, probabilidades completas, raw score, calibrated score, side, seleccion, decision y veredicto.
7. En revisiones compatibles, compara la respuesta del provider tradicional con `predict_from_snapshot` usando el contexto directo TypeScript.
8. Falla si el camino directo intenta usar el provider REST.
9. Incluye un modo `--compare` que alinea filas por `(variant, symbol)`, cuenta mismatches y calcula deltas numericos maximos.

El timestamp cerrado del fixture es `2026-08-02T20:00:00+00:00`. Todos los valores generados son finitos y el JSON usa serializacion determinista.

## Resultado entre revisiones

Baseline: `eab51262e7a54a09d479e6672475476565cd1dab`.

| Campo | Mismatches en `ba0ade1` | Mismatches en `1be2a02` | Delta absoluto maximo |
|---|---:|---:|---:|
| `feature_vector_hash` | 0/220 | 0/220 | N/A |
| `feature_values_hash` | 0/220 | 0/220 | N/A |
| `feature_count` | 0/220 | 0/220 | N/A |
| `long_prob` | 0/220 | 0/220 | 0.0 |
| `short_prob` | 0/220 | 0/220 | 0.0 |
| `neutral_prob` | 0/220 | 0/220 | 0.0 |
| `candidate_raw_score` | 0/220 | 0/220 | 0.0 |
| `candidate_calibrated_score` | 0/220 | 0/220 | 0.0 |
| `candidate_side` | 0/220 | 0/220 | N/A |
| `selected` | 0/220 | 0/220 | N/A |
| `decision` | 0/220 | 0/220 | N/A |
| `verdict` | 0/220 | 0/220 | N/A |

Total: cero mismatches para los dos candidatos historicos.

## Diversidad interna

Los tres commits produjeron exactamente la misma diversidad:

| Medida | Resultado por revision |
|---|---:|
| Filas | 220 |
| `feature_vector_hash` unicos | 220 |
| `feature_values_hash` unicos | 220 |
| `candidate_calibrated_score` unicos | 220 |
| Estados de `selected` | 2 |
| Decisiones | 2 |
| Veredictos | 2 |
| Vectores de probabilidad base | 1 |
| `candidate_raw_score` unicos | 1 |

El vector base fue:

```text
long_prob    = 0.00000011253514939093373
short_prob   = 0.99999977492970127
neutral_prob = 0.00000011253514939093373
```

El score calibrado fue variable:

```text
minimum = 0.000015390180482046212
maximum = 0.00013645593396809032
range   = 0.0001210657534860441
```

Esto separa dos conceptos que el log resumido mezclaba. La probabilidad direccional base decide el lado probable, mientras `candidate_calibrated_score` representa retorno direccional limpio esperado y es el valor usado para ranking y threshold del Current Brain.

## Paridad del contexto directo

La revision pre-contexto no contiene `market_snapshot_from_context` ni `predict_from_snapshot`, por lo que sus 22 comprobaciones se marcan correctamente como no soportadas.

En `ba0ade1` y `1be2a02` se compararon los dos extremos del fixture, con 11 simbolos en cada extremo:

| Revision | Soportadas | Coincidencias exactas | Llamadas REST desde ruta directa |
|---|---:|---:|---:|
| `ba0ade1` | 22/22 | 22/22 | 0 |
| `1be2a02` | 22/22 | 22/22 | 0 |

La igualdad incluye probabilidades, hashes y metadata de features, decision brain, turbo payload, raw score y calibrated score. El transporte directo no altera el resultado cientifico y no cae silenciosamente al provider REST.

## Comparacion de scikit-learn

`requirements.txt` declara `scikit-learn==1.7.2`, pero el interprete productivo observado `/home/jasan/.venv_rocm62/bin/python` carga `1.8.0`. Se creo un entorno temporal aislado con `1.7.2` y las mismas versiones observadas de Python, NumPy, SciPy, pandas y joblib.

Sobre el commit actual y las mismas 220 filas:

| Comparacion | Resultado |
|---|---:|
| Mismatches totales | 0 |
| Delta maximo de probabilidades | 0.0 |
| Delta maximo de raw score | 0.0 |
| Delta maximo de calibrated score | 0.0 |
| Hashes de features distintos | 0 |
| Decisiones distintas | 0 |
| Paridad contexto directo | 22/22 |

No hay evidencia de regresion numerica por esta diferencia de version en el camino auditado. La discrepancia entre version declarada y version cargada sigue siendo una desviacion de reproducibilidad operacional, aunque no cambio estos resultados.

## Semantica de `HOLD/1.000`

El `turbo_score` visible no tiene una unica semantica para todas las respuestas:

1. Si el selector hibrido confirma y selecciona un candidato, `turbo_score` es su `shadow_rank_score`.
2. Si el selector hibrido no selecciona candidato, `selected_prediction` es nulo y `turbo_score` cae a `candidate.raw_score`.
3. En el fixture, `candidate.raw_score` es la probabilidad direccional SHORT `0.99999977492970127`.
4. Un log que lo muestre redondeado aparece como `HOLD/1.000`, aunque las 83 features y el score economico hayan cambiado.

El selector hibrido no selecciona por esa probabilidad base. Construye candidatos LONG y SHORT desde el overlay de Entry Quality, evalua oportunidad, peligro, retorno neto, MAE/MFE, calidad relativa y confirmacion; ordena por `shadow_rank_score` y solo selecciona candidatos confirmados.

Por tanto, `HOLD/1.000` no significa `neutral_prob=1.0`, no prueba una cache cruzada y no significa que el sistema considere una entrada con confianza de 100%. Es la combinacion de abstencion del selector hibrido y fallback de presentacion al raw score direccional.

## Evidencia observacional de produccion

Se parseo una fotografia del archivo `logs/history-2026-09-02.log` hasta `16:11:28.002Z`:

| Medida | Valor |
|---|---:|
| Filas `aegis_scan` | 68.719 |
| Filas validas de modelo | 58.036 |
| `HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT` | 57.553 |
| `HYBRID_DIRECTIONAL_QUALITY_CONFIRMED` | 483 |
| Acciones SHORT | 358 |
| Acciones LONG | 125 |
| Scores validos unicos | 17 |
| Score valido minimo | 0.011460038614995961 |
| Score valido maximo | 0.9999997749297013 |

Cada simbolo canonico estuvo presente. Ocho simbolos mostraron entre dos y cuatro scores validos distintos; BTCUSDT, DOGEUSDT y SUIUSDT mostraron uno en la fotografia. Esta distribucion no permite medir calidad predictiva ni cantidad de inferencias unicas, pero si refuta que la salida global del runtime haya permanecido permanentemente fija durante el dia.

## Reproduccion

Ejemplo para generar un resultado desde un worktree historico:

```bash
PYTHONPATH=/tmp/opencode/aegis-pre-context/src \
  /home/jasan/.venv_rocm62/bin/python \
  /home/jasan/Develop/trading_system/scripts/audit_aegis_probability_regression.py \
  --artifact-root /home/jasan/Develop/trading_system \
  --output /tmp/opencode/aegis-pre-context-result.json
```

Comparacion reproducible:

```bash
PYTHONPATH=src /home/jasan/.venv_rocm62/bin/python \
  scripts/audit_aegis_probability_regression.py \
  --output /tmp/opencode/aegis-revision-comparison.json \
  --compare \
  /tmp/opencode/aegis-pre-context-result.json \
  /tmp/opencode/aegis-context-integration-result.json \
  /tmp/opencode/aegis-current-audit-result.json
```

Los resumenes generados durante esta auditoria quedaron en:

- `/tmp/opencode/aegis-revision-comparison.json`
- `/tmp/opencode/aegis-sklearn-comparison.json`

## Limitaciones

1. El fixture es sintetico y determinista; demuestra equivalencia de codigo, no rentabilidad ni calibracion sobre mercado real.
2. Se uso el mismo artefacto actual en todas las revisiones para aislar codigo y runtime. No se compararon artefactos historicos de modelo.
3. El replay principal cubre Current Brain y la paridad de transporte. No reconstruye offline todo el observer de investigacion que alimenta al selector hibrido.
4. La evidencia de produccion es observacional y contiene posibles repeticiones por polling o cache; no debe interpretarse como cantidad de inferencias unicas.
5. Cero diferencias en 220 casos no constituye una prueba universal para todo snapshot posible, pero si una comprobacion fuerte sobre entradas variadas y las revisiones concretas.

## Conclusion

La hipotesis de una regresion causada por Micro Burst o por el transporte directo TypeScript -> Aegis no esta respaldada por la evidencia. Las features cambian, el score economico cambia, las decisiones cambian cuando cruza los gates y todos esos valores son identicos entre el baseline historico y el runtime actual para el fixture auditado.

La probabilidad direccional base saturada merece seguimiento como propiedad del artefacto/modelo, pero no es una regresion reciente. Ademas, no inmoviliza por si sola al selector LIVE: el selector hibrido usa predicciones y confirmaciones separadas, y el log completo del dia contiene decisiones LONG y SHORT con scores variables.
