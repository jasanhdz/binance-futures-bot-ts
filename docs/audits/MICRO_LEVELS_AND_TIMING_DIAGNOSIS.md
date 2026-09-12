# Micro Levels And Timing Diagnosis

Auditoria USER READONLY, 2026-09-11 UTC. Informe en espanol ASCII.
Las secciones 1-9 conservan el diagnostico historico. La seccion 10 documenta
la implementacion posterior autorizada, sus pruebas y una incidencia de aislamiento.
Repositorio: `jasanhdz/binance-futures-bot-ts`.
Rama: `work/micro-burst-rider-v1-20260826`.

## 1. Dictamen

**El resultado es mixto: restricciones reales de mercado/estrategia, defectos
reproducibles de temporalidad/seleccion y carencias de observabilidad. No procede
afirmar ni que todo funciona correctamente ni que basta con bajar filtros.**

La ventana principal cerrada es **[2026-09-11T05:05:00.000Z,
2026-09-11T05:35:00.000Z)**, exactamente 30 minutos por `strategyTimestampMs`.
Se analizaron **721 decisiones unicas**, todas Micro LIVE del mismo commit
declarado, con **0 ENTRY_INTENT**. Hay 115 rechazos de contexto, 43 rechazos
posteriores BTC y 563 evaluaciones que alcanzan el analisis de ambos lados.
Cuatro evaluaciones ETH LONG superan el trigger: dos fallan por deterioro de
defensa y dos por espacio bruto insuficiente. No hay candidatos que alcancen
la prueba final de room/RR netos en esta ventana.

Hallazgos priorizados:

| Prioridad | Clase | Hallazgo y alcance demostrado                                                                                                                                                                                                                                                                                                                                        |
| --------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1        | B     | La observacion blackbox esta en el camino critico antes de evaluar. El contexto, book ejecutable y reloj de frescura quedan fijados antes de esa espera. Un contrato sintetico reproduce ENTRY_INTENT despues de avanzar 90 s el reloj externo, porque se valida el reloj anterior. No demuestra una orden real obsoleta: existen barreras posteriores de ejecucion. |
| P1        | B/D   | Seleccion geometrica respecto al cierre 5m, contexto respecto al cierre 1m y ejecucion respecto al ask/bid previo a blackbox. No se reorientan los nearest ni el target al precio ejecutable. Un target ya cruzado produce rechazo aun existiendo otro opposing level. Falta evidencia para contar cuantos rechazos reales son atribuibles a ello.                   |
| P2        | B/C   | Se elige un solo candidato por distancia antes de validar su disponibilidad y patron; no se prueba otra defensa confirmada. Contrato sintetico: nearest tardio bloquea una defensa alternativa valida. Si se desea deliberadamente una politica nearest-only, debe documentarse como restriccion, no llamarse ausencia global de niveles.                            |
| P2        | C/D   | Clusters usan la confirmacion mas reciente de sus pivots. Un nuevo pivot al mismo precio mueve `availableAtMs` hacia adelante y puede invalidar la utilizacion de una defensa anteriormente confirmada. Reproducido, pero conservar la fuerza agregada futura con el timestamp antiguo seria lookahead. Se necesita una politica explicita de versiones as-of.       |
| P2        | A/C/D | 343 evaluaciones tienen al menos un rechazo de niveles: 321 muestran soporte ausente, 8 ambos ausentes y 14 ambos presentes sin informacion suficiente para atribuirlo a timing. El nombre `LEVEL_NOT_CONFIRMED_BEFORE_TRIGGER` agrupa causas distintas.                                                                                                             |
| P2        | A/C   | ETH tiene oportunidades con trigger pero no suficiente espacio: 12.4343 y 21.4338 bps frente a 30 bps minimos. Son rechazos economicos explicitos, no un bloqueo de journal.                                                                                                                                                                                         |
| P2        | D     | No hay replay exacto de los inputs Micro, timestamps completos de decision ni trazas enqueue/dequeue. Las features blackbox posteriores a construir el contexto no son sus inputs originales.                                                                                                                                                                        |

Clases: **A** comportamiento esperado de seguridad/contrato; **B** mecanismo
defectuoso o discrepancia reproducida frente a un contrato explicito; **C**
restriccion estrategica/economica que requiere validacion fuera de muestra; **D**
observabilidad insuficiente. Una discrepancia sintetica B no prueba prevalencia
en mercado ni obliga a adoptar el contrato propuesto sin revision.

## 2. Alcance Y Procedencia

### Limites Operativos

- Se leyeron `AGENTS.md`, documentacion de unificacion, contexto V3 y auditoria diaria/ADA. Las autorizaciones historicas de deployment no se aplicaron a esta solicitud.
- Worktree y staging estaban limpios al inicio y seguian sin cambios antes de crear este informe. No existia este informe previamente.
- Unico archivo de trabajo creado en el repositorio: este informe, mediante `apply_patch`. Fixtures y analizadores en `/tmp/opencode`.
- No se editaron source, thresholds, YAML, `.env`, `dist`, LIVE flags, estados, locks, reservas, journals ni ledger. No bootstrap del bot, build, restart, clear, orden, cancelacion, commit, staging ni push.
- No se leyo `.env` ni se imprimio el entorno completo. `pm2 jlist` se filtro dentro de Node a metadata de proceso; no credenciales.
- No se consulto ningun endpoint de cuenta/exchange. La unica peticion diagnostica adicional fue GET a `http://127.0.0.1:8010/diagnostics/market-data`, despues de revisar su implementacion. No se inicio servidor.
- No se abrio SQLite: los rechazos y journals existentes bastan para esta pregunta. No se instancio ningun constructor de almacenamiento operativo.
- No hay herramienta de subagentes disponible en esta sesion. Se separaron los bloques niveles/contratos, flujo temporal y agregados/procedencia, con lecturas independientes en paralelo. No se atribuye el trabajo a agentes inexistentes.

### Identidad Verificada

| Evidencia                                         | Resultado                                                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Primera inspeccion UTC                            | 2026-09-11T00:49:18Z                                                                                                 |
| HEAD local                                        | `8c04b214616cdc8d3975143b2691b7cfb9c9ad4b`                                                                           |
| Remote tracking local                             | mismo SHA; consultado por separado, no equivalente a consultar el remoto                                             |
| HEAD remoto real                                  | mismo SHA mediante `git ls-remote origin refs/heads/work/micro-burst-rider-v1-20260826`; repetido al verificar tests |
| PM2 actual                                        | `01-Trading-Bot`, PID `47506`, `online`; nuevamente comprobado tras reanudar                                         |
| Arranque PM2                                      | `1789077576487`, 2026-09-10T21:59:36.487Z                                                                            |
| Boot log                                          | `logs/history-2026-09-10.log:5171`, 21:59:37.262Z                                                                    |
| Ejecutable declarado por PM2                      | `dist/main.js`, cwd de este repositorio, Node v24.20.0                                                               |
| Identidad en 721 decisiones                       | `MICRO_BURST` / `MICRO`, `FROZEN_LIVE`, modo LIVE, SHA `8c04b21...`                                                  |
| Config efectiva declarada al boot y en decisiones | `132879584379e97474309df05d99552a6b835fecdcbe38d3b586b7bfb76633e1`                                                   |
| Hash de estrategia declarado                      | `e80e0569ef6188fb0fb52db8d50d971c9b8643378d77d55fa4cc8c71aa7405a6`                                                   |
| Config recalculada offline con loader instalado   | exactamente el mismo hash efectivo                                                                                   |
| SHA-256 del YAML leido                            | `5935f7cbf9c1837efa82e84e226dcb9f4e7e4a182ff06b975f98ebae6ce97a1e`                                                   |

`logs/history-2026-09-10.log:5175-5179` enlaza el boot con policy MICRO, commit
deployed/approved, hash efectivo, 11 simbolos, intervalo 5000 ms y blackbox
adjunto. La ventana esta despues de ese boot y todas sus identidades coinciden.
Los registros no llevan PID: la atribucion al proceso se apoya en el boot y PM2,
no en una supuesta columna PID. No se usa el nombre historico de rama como selector.
Los aliases legacy siguen siendo validos en lectura/recuperacion
(`src/core/strategy/MicroBurstLegacy.ts`), sin reescribir identidades persistidas.

**Artefacto:** se transpilaron 21 modulos TS en memoria, sin emitir archivos, y
los 21 resultados coinciden byte a byte con el JS instalado. Sus mtimes son
2026-09-10T21:59:01.304Z a 21:59:01.883Z, anteriores al boot. Incluyen main,
router, snapshot provider, proveedor de candles, integridad, observador/blackbox,
S/R, reaccion, geometria, context builder, BTC provider, strategy, types,
trade policy, evaluator, runtime y loader/hash de config, ademas de BinanceAdapter.

Esto verifica la correspondencia de esos archivos instalados con el source
inspeccionado. **No verifica todo `dist`, dependencias, memoria cargada, ni ausencia
de sustituciones historicas de archivos.** El `strategyHash` declarado tampoco
es una medicion de todos los bytes ejecutados. El manifest encontrado en
`/tmp/opencode/approved-artifact-manifest.json` corresponde a `a54cd21...`;
no se lo utilizo como certificacion de `8c04b21`.

### Metodo De Conteo

El analizador lee cada JSONL como stream con un limite de bytes fijado por `stat`
al abrirlo. No modifica ni bloquea el escritor. Filtra por timestamp de
estrategia en el rango semiabierto, estrategia canonica y deduplica por
`decisionId`. Resultado: 0 duplicados y 0 duplicados conflictivos.
Los 721 snapshots referenciados estan disponibles, sin aliases de deduplicacion
ni discrepancias entre los content hashes almacenados en decision y snapshot.
Esto es consistencia de referencias, no una segunda recomputacion de cada
content hash ni una prueba de replay exacto.

El log por reloj de publicacion tiene 718 mensajes `micro_burst_entry_policy_selected`
en el mismo rango de pared. Al unir por `symbol + snapshotAtMs`, incluyendo la
publicacion posterior al extremo final, aparecen exactamente **721/721** y
ningun mensaje sin correspondencia. No se suman ambos canales.

Se detectaron cuatro lineas JSON malformadas preexistentes en decisions
(1651, 4698, 18281, 97600), una en snapshots (59893) y una en el log del dia 10
(2139). Sus timestamps extraibles estan fuera de la ventana principal; todas
las decisiones de esta ventana tienen union independiente en el log. No se
repararon ni se presento la totalidad historica del archivo como integra.

Los contadores de health son acumulados desde boot y muestreados en otros
instantes; no sustituyen este conteo exacto. Archivos rotados listados son
anteriores a esta ventana; no se anadieron registros antiguos al denominador.

## 3. Ausencia De Entradas

### Embudo Disjunto

Para evitar duplicar guards comunes, una evaluacion cuenta una vez. Para las
etapas por lado, se clasifica la evaluacion por el lado que mas avanzo; se
publica ademas la tabla completa por lado. Esto no afirma que el otro lado haya
superado las mismas etapas.

| Etapa terminal de la evaluacion          |  Unicas |
| ---------------------------------------- | ------: |
| Contexto invalido, guard comun           |     115 |
| BTC_UNAVAILABLE posterior, guard comun   |      43 |
| Ambos lados detenidos en niveles         |     341 |
| Mejor lado detenido en proximidad        |       0 |
| Mejor lado detenido en direccion/flow    |     155 |
| Mejor lado detenido en trigger           |      63 |
| Mejor lado detenido en defensa degradada |       2 |
| Mejor lado detenido en room bruto        |       2 |
| ENTRY_INTENT                             |       0 |
| **Total**                                | **721** |

Alcances unicos: 606 pasan calidad, 563 pasan todos los guards comunes, 222
superan niveles al menos por un lado, los mismos 222 superan proximidad por
algun lado, 67 llegan al trigger, 4 lo superan, 2 superan deterioro/BTC/geometria
y llegan al room bruto, 0 pasan room bruto. Por tanto RR bruto, leverage y
costes netos no tienen candidatos entrantes en esta muestra.

### Primer Rechazo Por Lado

Cada columna tiene denominador 721. Los guards comunes 115 + 43 representan
158 evaluaciones, **no 316 evaluaciones**. Tras esos guards, cada lado tiene
563 oportunidades de evaluar su cadena. No se suman LONG/SHORT para obtener
el total de evaluaciones.

| Primer rechazo                                                      | LONG | SHORT | Evaluaciones con el motivo en algun lado |
| ------------------------------------------------------------------- | ---: | ----: | ---------------------------------------: |
| REACTION_CONTEXT_INVALID                                            |  115 |   115 |                                      115 |
| BTC_UNAVAILABLE                                                     |   43 |    43 |                                       43 |
| REACTION_LEVEL_NOT_CONFIRMED_BEFORE_TRIGGER                         |  343 |   341 |                                      343 |
| REACTION_NOT_NEAR_LEVEL                                             |   21 |     1 |                                       22 |
| REACTION_DIRECTION_NOT_CONFIRMED                                    |  177 |   176 |                                      217 |
| REACTION_TRIGGER_MISSING                                            |   18 |    45 |                                       63 |
| REACTION_DEFENSE_DEGRADING                                          |    2 |     0 |                                        2 |
| INSUFFICIENT_ROOM                                                   |    2 |     0 |                                        2 |
| BTC_CONFLICT, geometria invalida, RR insuficiente, LOW_CONFIRMATION |    0 |     0 |                                        0 |
| REACTION_NET_ROOM_INSUFFICIENT / REACTION_CONFIRMED                 |    0 |     0 |                                        0 |

La ultima columna es **solapada**, no un embudo disjunto. Tampoco representa
todos los problemas contrafactuales: el codigo hace `continue` al primer fallo
de cada lado. Los checks posteriores a ese fallo no fueron ejecutados.

### Simbolos Y Lados

`L/S` denota LONG/SHORT. `Nivel`, `Cerca`, `Direccion`, `Trigger`, `Defensa`,
`Room` son primeros rechazos. `Calidad` y `BTC` se cuentan una vez por evaluacion.

| Simbolo   |       N | Calidad |    BTC | Pasa comunes | Nivel L/S   | Cerca L/S | Direccion L/S | Trigger L/S | Defensa L/S | Room L/S |
| --------- | ------: | ------: | -----: | -----------: | ----------- | --------- | ------------- | ----------- | ----------- | -------- |
| ADAUSDT   |      65 |       3 |      6 |           56 | 56/56       | 0/0       | 0/0           | 0/0         | 0/0         | 0/0      |
| AVAXUSDT  |      64 |      10 |      3 |           51 | 2/2         | 0/1       | 40/41         | 9/7         | 0/0         | 0/0      |
| BNBUSDT   |      66 |      15 |      1 |           50 | 50/50       | 0/0       | 0/0           | 0/0         | 0/0         | 0/0      |
| BTCUSDT   |      67 |       9 |      5 |           53 | 39/39       | 0/0       | 14/12         | 0/2         | 0/0         | 0/0      |
| DOGEUSDT  |      66 |       7 |      6 |           53 | 53/53       | 0/0       | 0/0           | 0/0         | 0/0         | 0/0      |
| ETHUSDT   |      68 |      12 |      4 |           52 | 2/2         | 0/0       | 41/44         | 5/6         | 2/0         | 2/0      |
| LINKUSDT  |      64 |      14 |      4 |           46 | 3/3         | 0/0       | 39/36         | 4/7         | 0/0         | 0/0      |
| LTCUSDT   |      65 |       9 |      4 |           52 | 29/27       | 4/0       | 19/9          | 0/16        | 0/0         | 0/0      |
| SOLUSDT   |      66 |      14 |      2 |           50 | 9/9         | 17/0      | 24/34         | 0/7         | 0/0         | 0/0      |
| SUIUSDT   |      65 |      13 |      3 |           49 | 49/49       | 0/0       | 0/0           | 0/0         | 0/0         | 0/0      |
| XRPUSDT   |      65 |       9 |      5 |           51 | 51/51       | 0/0       | 0/0           | 0/0         | 0/0         | 0/0      |
| **Total** | **721** | **115** | **43** |      **563** | **343/341** | **21/1**  | **177/176**   | **18/45**   | **2/0**     | **2/0**  |

**Familias:** en ambos lados, `RECLAIM_REVERSAL`,
`TREND_RETEST_CONTINUATION` y `BREAKOUT_RETEST_CONTINUATION` tienen 0 etiquetas
registradas; `UNCLASSIFIED` tiene 721 por lado. Tambien las cuatro evaluaciones
post-trigger carecen de `diagnostics.setup`: esa variable se calcula antes,
pero solo se publica despues de superar la evaluacion estructural
(`MicroBurstReactionEntryPolicy.ts:244-310`). No inferir reversal/continuation
por el signo posterior del precio, por regimen o por `hasRetest` aislado.

### Componentes Solapados

Sobre los 115 contextos invalidos, `invalidReasons` contiene:

| Componente                                                                              | Evaluaciones |
| --------------------------------------------------------------------------------------- | -----------: |
| btc_event_stale                                                                         |          101 |
| btc_stale, edad de recepcion                                                            |           16 |
| insufficient_1m_candles, stale_1m_candles, 1m_candle_in_future, invalid_reference_price |  11 cada uno |
| insufficient_3m_candles, stale_3m_candles, 3m_candle_in_future                          |   3 cada uno |
| insufficient_5m_candles, stale_5m_candles, 5m_candle_in_future                          |   4 cada uno |

No sumar estos componentes: un rechazo de preparacion vacia el conjunto y
genera tambien insuficiencia/frescura derivadas. No equivale a cuatro fallos
independientes del feed. No se observaron otros invalidReasons en la ventana.

Entre los rechazos de direccion: LONG tiene 170 discrepancias de momentum y
98 de signo/flow; SHORT 160 y 118 respectivamente. Son componentes solapados
de 177 y 176 primeros rechazos, no nuevos rechazos.

Entre los rechazos de trigger: LONG tiene 13 sin toque y 12 con candle adversa
(sobre 18); SHORT 29 sin toque, 13 adversas, 34 sin reclaim ni retest y 2 sin
visitas (sobre 45). No se suman como candidatos independientes.

### Admission Y Journals

Las 30 muestras `strategy_entry_gate_summary` de MICRO dentro del rango de
publicacion tienen total 0. Las otras 30 pertenecen a MOMENTUM_RIDE y se excluyen.
Los journals existentes entry/close/stop tienen **0 eventos** por `timestampMs`
en la ventana. El close journal esta vacio; entry y stop tienen ultima marca
`1789075642126` y `1789075639709`, anteriores al boot actual.

Esto apoya que no se alcanzo admission desde nuevas senales Micro. No acredita
0 posiciones ni 0 ordenes en la cuenta: no se hizo una consulta actual de cuenta.
Un `MICRO_NET_LOSS_CLOCK_UNAVAILABLE` en el boot es evidencia de aquel instante,
no del estado actual. Pendientes de ledger, ambiguedades historicas y flags de
seguridad no explican estos NO_TRADE, emitidos antes de admission. No se limpiaron.

## 4. Auditoria De Niveles

### Construccion Y Config Real

Rutas de codigo, en el HEAD verificado:

| Paso                         | Source y contrato                                                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candle requests del contexto | `src/strategies/micro-burst/domain/MicroBurstContextBuilder.ts:222-257`: pide 100 x 1m, 80 x 3m, 60 x 5m en Promise.all                                                                        |
| Preparacion                  | `src/core/market-data/CandleIntegrity.ts:175-194`: valida secuencia original y elimina a lo sumo la ultima candle abierta; rechaza una respuesta que contiene mas candles posteriores al as-of |
| Minimos                      | `MicroBurstContextBuilder.ts:141-146`: 30/20/15 candles cerradas y edades maximas 120/360/600 s                                                                                                |
| Lookback S/R                 | `MicroBurstContextBuilder.ts:264-272`, `MicroBurstTypes.ts:392-410`: **20 candles 5m**, nominalmente 100 minutos; no 120 candles 5m                                                            |
| Pivot                        | `MicroBurstSupportResistance.ts:42-70`: comparaciones estrictas a 3 barras izquierdas y 3 derechas; empates no forman pivot                                                                    |
| Disponibilidad               | cierre de la tercera candle derecha, 15 minutos despues del cierre del pivot; no la fecha del pivot                                                                                            |
| Clustering                   | `MicroBurstSupportResistance.ts:103-146`: agrupa por distancia a media corriente, tolerancia 15 bps, precio medio, confirmacion mas reciente                                                   |
| Fuerza                       | min(1, touches/5 _ 0.5 + pivots/3 _ 0.3 + 0.2 si volumen positivo), minimo 0.3; touches usa high o low y no solo el tipo del pivot                                                             |
| Nearest                      | `MicroBurstSupportResistance.ts:149-176,214-218`: support tipado debajo y resistance tipada encima del ultimo **close 5m**, desigualdad estricta                                               |
| Precio contextual            | `MicroBurstContextBuilder.ts:258-263`: ultimo close **1m**, no mark ni book                                                                                                                    |
| Precio de entrada            | `MicroBurstReactionEntryPolicy.ts:116-137`: ask LONG / bid SHORT del executionBook capturado antes del observer                                                                                |

El adaptador REST tiene caches por simbolo/intervalo, TTL 5/7/10 s y minFetch
240/240/320 para 1m/3m/5m (`BinanceAdapter.ts:111-146,554-567`). La cantidad
descargada no es el lookback usado por S/R. El contexto usa exchange.getCandles,
no el candleDataPlane 5m del endpoint de diagnostico compartido. Ver 319
candles WS sanas en ese endpoint no demuestra que Micro use ese mismo conjunto.

El loader actual no expone override S/R por simbolo: solo BTC conflict y opciones
de book entre las propiedades pertinentes. Se verifico que el YAML efectivo no
introduce overrides de S/R ni exit-cost. Defaults efectivos de entrada: near
50 bps, buffer estructural 20 bps, room 30 bps, RR 1.5, coste residual 14 bps,
buffer de destino 2 bps, book/context 30 s, BTC 60 s, spread anomalo 20 bps,
conflicto BTC 30 bps. La politica resuelta limita leverage a 20/30 y margen 0.9;
los defaults legacy 40/50 no son los tiers efectivos de MICRO.

### Seleccion Y Rechazos

`MicroBurstReactionEntryPolicy.ts:119-155` combina nearest defendido y niveles
rotos del tipo opuesto, elige el mas cercano y solo despues verifica existencia,
finitud y `availableAtMs <= latest.openTime`. No itera alternativas del mismo
tipo defendido y no avanza a otra alternativa si el primero falla confirmacion,
proximidad, direccion o patron. El target se toma del nearest original.

Para role reversal se exige una ruptura cerrada posterior a disponibilidad,
con close anterior a la apertura de la ultima candle. La candle de ruptura no
es su propio retest (`:120-133,178-188`). La variable `roleReversed` no retipa
el objeto ni recalcula el target. Un nivel roto que siga siendo el nearest
opuesto desde el cierre 5m puede coincidir con el target o dejarlo al lado
incorrecto del precio ejecutable. La geometria posterior lo rechaza, pero no
selecciona otro opposing level. No se observo una entrada geometrica invalida.

Las visitas adyacentes se agrupan; alejamiento favorable reinicia visita.
Deterioro compara la maxima rejection de la ultima visita con la previa.
Un cierre adverso marca `broken` de forma acumulada dentro de la historia
recorrida; limita `retest`, no elimina por si solo un reclaim posterior. Son
reglas de patron, no probabilidades calibradas.

La funcion S/R filtra candles posteriores al snapshot antes de detectar pivots;
no se encontro inclusion directa de pivots futuros respecto a ese snapshot.
Sin embargo, el trigger exige disponibilidad anterior a su apertura. La
confirmacion maxima del cluster puede ser posterior a esa apertura aunque el
mismo precio tuviera un pivot anterior. Para corregirlo no basta con cambiar
`max` a `min`: precio medio, fuerza, touches y volumen tambien deben existir
as-of. Debe distinguirse nueva version de cluster de continuidad de una defensa.

### Desglose De Ausencias

Sobre primeros rechazos de niveles, leyendo los nulls originales:

| Estado registrado                                       |    LONG |   SHORT | Unicas en algun lado |
| ------------------------------------------------------- | ------: | ------: | -------------------: |
| Solo soporte ausente                                    |     321 |     321 |                  321 |
| Solo resistencia ausente                                |       0 |       0 |                    0 |
| Ambos ausentes                                          |       8 |       8 |                    8 |
| Ambos presentes, disponibilidad/seleccion indeterminada |      14 |      12 |                   14 |
| **Total**                                               | **343** | **341** |              **343** |

Ausencia de soporte en sentido inclusivo: 329; ausencia de resistencia
inclusiva: 8; alguna ausencia: 329. No se deriva `bothAbsent` restando totales:
los 8 se contaron directamente cuando ambos campos eran null. Estos estados
son de las evaluaciones que publican el rechazo, no de los 721 contextos completos.
`null nearest` tampoco prueba ausencia de todos los pivots en el lookback:
pueden quedar del otro lado del close 5m o no superar fuerza/confirmacion.

Proximidad: 17 LONG muestran `distanceBps > maxBps`; 4 LONG y 1 SHORT tienen
distancia <= 50 bps. Su rama de codigo implica lado no favorable o igualdad,
pero no se registra precio ejecutable/signo para una separacion independiente.
**17 far demostrados; 5 no-far con causa de signo/igualdad inferida por rama;
interseccion far + wrong-side desconocida.** No son 22 distancias grandes.

### Casos Reales As-Of

Todos los casos siguientes salvo la fila historica pertenecen a la ventana
principal. `D:L` indica linea en `data/strategy-blackbox/strategy-decisions/decisions-v2.jsonl`.
Se conservan inputs diagnosticos publicados, no reconstrucciones posteriores.

| UTC estrategia                              | Simbolo/lado | Evidencia                                                                       | Diagnostico verificable                                                                              |
| ------------------------------------------- | ------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 05:05:16.387                                | SUI ambos    | D:111319, id `40992570aea46e880700036ce5474045cc5a49654b2d8fd7647c37524354a742` | support null, resistance 0.7424; nivel ausente, no prueba de confirmacion tardia                     |
| 05:05:16.988                                | BNB ambos    | D:111320, id `4c23fa4abb128e5d059dbcb8e94a49f8876b16e484cb94dbbe8b710dda143274` | support null y resistance null; ejemplo completo de both missing                                     |
| 05:05:22.706                                | ADA ambos    | D:111321, id `a06e7cb2510ce8db5956817debd34e31531a9dec38c3bcf1aaef5b0b82963149` | support null, resistance 0.2104; no llego a comprobar una lower rejection/reclaim                    |
| 05:05:37.997                                | BTC ambos    | D:111327, id `64e700b2449822ac6343ccd0b1bffe99a161c2304fac41bf76b054ad685d83e5` | support null, resistance 77166.6                                                                     |
| 05:12:18.690                                | ETH LONG     | D:111488, id `b56805a1b6ccc8fded5eb7244d5de9404c298203f27bb1c0319bfc9d3e902ee1` | trigger/defensa/BTC/geometria superados; room bruto 12.434273082643 < 30                             |
| 05:12:44.277                                | ETH LONG     | D:111498, id `b92df00486d053e34e7b1f6a807cbbebd0576fbeb385dadae1efd317f6ce83b2` | room bruto 21.433829660028 < 30                                                                      |
| 05:17:23.418                                | ETH LONG     | D:111610, id `d7600d88347548c5d105b7ba2c7e34c4f11928a2520521984025b0e260d90969` | ultima rejection 18.898741034298 < previa 21.016703391590 bps                                        |
| 05:30:19.407                                | ETH ambos    | D:111921, id `14c07a2e846662e8a495805e43a741e011bfe4db7047a8eeb97e1799cb1b74c5` | support 2455.19, resistance 2462.615; falta availableAt/triggerOpen/candidato para atribucion exacta |
| 05:33:15.118                                | LTC LONG     | D:111991, id `1cf4a86ea6c73a891de7bb8faab683b04db20bd25c3917053188fe3785baedc3` | nivel 52.74, distancia 9.489466691973 <= 50; NOT_NEAR no significa siempre lejos                     |
| 2026-09-10 22:04:40.738, historico separado | LTC ambos    | D:100488, id `0cd298d628d45e1b710fc3b77e3a46a8f86caaaf354d08d6f2d78c08d2ab8f92` | support 52.26, resistance null; ejemplo de missing resistance que no existe en la ventana principal  |

El segundo rechazo ETH por deterioro es D:111621 a 05:17:48.817,
id `944c6d09b525a72cb0883a4bd9898c47bfc16284c91d4d4342517f7d9a5cb5c0`,
con los mismos valores de rejection. Es otra evaluacion, no otra visita probada.
Ni ADA ni SUI pueden etiquetarse como una entrada que debio activarse al ver una
mecha en un grafico posterior. No se aportaron sus candles y niveles completos
con disponibilidad original para esa afirmacion.

## 5. Auditoria Temporal

### Secuencia Real Del Codigo

1. El scheduler dispara cada 5000 ms, recorre simbolos con await y tiene exclusion por simbolo; callbacks del setInterval pueden solaparse (`MicroBurstRuntime.ts:665-681,1226-1233`). No hay contador historico de todos los ticks saltados.
2. `MicroBurstEvaluator.ts:61` obtiene server time por REST encolado. Ese valor queda como `snapshotAtMs`/timestamp de estrategia.
3. El context builder espera las tres lecturas de candles. El Promise.all no elimina la serializacion en la cola del adaptador. Despues toma book, BTC y flow actuales y guarda dataQuality respecto a relojes distintos.
4. `MicroBurstEvaluator.ts:73-85` captura executionBook y `observedAtMs` local, antes de entrar al router.
5. `StrategyRouter.ts:45` espera `captureObservation`. `MarketSnapshotProvider.ts:122-128,238-257` lee quote/book/flow, espera candles primarias y despues benchmark. Cada `MarketDataCandleProvider.getSeries` espera server time y luego candles (`:59-65`).
6. Solo entonces `StrategyRouter.ts:59` llama a la estrategia. `MicroBurstStrategy.ts:51-55` pasa el `observedAtMs` anterior, sin actualizarlo tras el await. Las guardas no miden el reloj actual de esa llamada.
7. Se persiste la observacion y se devuelve el resultado (`StrategyRouter.ts:68`). `StrategyDecisionBlackBox.ts:143,191` usa por defecto `snapshot.capturedAtMs` como `evaluatedAtReceivedMs`, **no una medicion de fin de evaluacion**.
8. `recordedAtMs` se toma al construir el registro despues del append de snapshot; no es necesariamente flush/fsync completado. Luego se publica el log y se sigue con deduplicacion/admission si existe intento.

`BinanceAdapter.ts:271-315` encadena todos los tasks en una Promise queue,
adquiere rate limiter, espera cooldown/presupuesto/min-gap, ejecuta REST y
actualiza la proxima salida. `getServerTime` siempre encola; getCandles evita
REST solo si cache vigente. El timestamp de cache se toma **antes** de esperar
fetch (`:557,566`), por lo que una espera consume su TTL. No se mide aqui la
fraccion exacta de red, cola, rate limit o CPU. Ausencia de 429 no equivale a
ausencia de espera.

### Dominios De Timestamp

| Campo                              | Semantica y limite                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Binance depth E / T                | evento / transaccion del exchange; no son recepcion local ni estan preservados como timestamps de decision en estos compactos |
| aggTrade eventTime / tradeTime     | eventTime alimenta el watermark (`RollingAggTradeBuffer.ts:74-76,204-206`); tradeTime no sustituye silenciosamente ese campo  |
| receivedAtMs de depth              | `SynchronizedOrderBook.ts:331-332` actualiza observedAtMs con recepcion local                                                 |
| Candle closeTime                   | cierre inclusivo del intervalo; su edad natural puede llegar al periodo aun con transporte sano                               |
| BTC observedAtMs                   | ultimo cierre de candle empleado en returns, no una cotizacion BTC tick                                                       |
| BTC receivedAtMs                   | cuando termina el poll; frescura de recepcion distinta de edad del evento                                                     |
| snapshotAtMs / strategyTimestampMs | server time tomado antes de leer los candles del contexto                                                                     |
| context observedAtMs               | reloj local antes de blackbox; no conservado como campo propio en estos registros                                             |
| captureStartedAtMs / capturedAtMs  | inicio y fin locales del proceso de captura observacional                                                                     |
| evaluatedAtReceivedMs              | alias por defecto de capturedAtMs en este productor                                                                           |
| recordedAtMs / log ts              | construccion/publicacion posterior, no inicio/fin CPU ni durabilidad garantizada                                              |

BTC provider acepta hasta 120 s internamente y programa refresh de 1m con
boundary+250 ms y retry acotado (`BtcMicroContextProvider.ts:8-11,148-171,178-196`).
Micro exige 60 s tanto por recepcion en builder como por evento en reaccion.
Puede haber BTC disponible para el provider pero no suficientemente fresco para
entrada. El contexto compara evento con snapshot server; reaccion lo compara
con observedAt local posterior. Esto explica que existan rechazos BTC despues
de pasar dataQuality, sin probar que todos se deban a una sola causa.

El conflictFlag inicial segun structuralPosition no es un guard global de
reaccion: se recalcula por lado despues del trigger (`ReactionEntryPolicy.ts:253-269`).
No se atribuyen los 43 BTC_UNAVAILABLE a conflicto direccional.

### Metricas Principales

Todas en milisegundos, n=721 pares unicos. Percentil **nearest rank**:
ordenar n valores y seleccionar indice `ceil(p*n)-1`. No se calculan percentiles
sobre registros duplicados de log/telemetria. No se resta la mediana de una
serie de la de otra para inventar una descomposicion.

| Metrica                                       |   Min |   p50 |   p95 |   Max | Interpretacion                                                                            |
| --------------------------------------------- | ----: | ----: | ----: | ----: | ----------------------------------------------------------------------------------------- |
| capturedAt - strategyTimestamp                | 13790 | 20802 | 23336 | 25343 | Diferencia de relojes local/server; NO latencia pura de decision                          |
| captureStartedAt - strategyTimestamp          |  2978 |  4497 |  5906 |  7921 | Proxy mixto de fase previa; no mide toda la cola inicial de server time                   |
| capturedAt - captureStartedAt                 |  9826 | 16269 | 18647 | 21394 | Duracion observacional local, esperada antes de strategy.evaluate                         |
| recordedAt - capturedAt                       |     0 |     2 |    31 |    59 | Tramo hasta crear registro; incluye mas que calculo y no prueba flush                     |
| capturedAt - quote.sourceTimestamp            |  9887 | 16376 | 18728 | 21499 | Edad de recepcion del quote observado al fin de captura, no edad exacta del executionBook |
| capturedAt - bookFeatures.sourceTimestamp     |  9887 | 16376 | 18728 | 21499 | Misma fuente local que quote                                                              |
| capturedAt - aggTrade.sourceTimestamp         | 10392 | 17232 | 22742 | 34610 | Edad del watermark E al capturar; reloj mixto, no transporte E->recv                      |
| capturedAt - primaryCandles.sourceTimestamp   |  2296 |  8282 | 10122 | 11659 | Edad de recepcion del resultado REST, NO edad del ultimo candle cerrado                   |
| capturedAt - benchmarkCandles.sourceTimestamp |     0 |     0 |     0 |     1 | Benchmark leido al final; NO edad del evento BTC ni del BTC context usado                 |

La captura observacional por si sola cuesta 9.826-21.394 s en esta ventana;
esto es un intervalo medido en un mismo reloj y una dependencia de codigo
comprobada. No se atribuye un porcentaje exacto a espera de rate limiter/REST
sin spans. Tampoco se llama "20.8 s de CPU" a la diferencia mixta.

### Metricas Por Simbolo

Cada celda es `p50 / p95 / max`, ms. `Gap` es capturedAt menos strategyTimestamp
(mixto); `Captura` es duracion local; `Quote` edad local al capture; `Flow` edad
mixta del watermark E; `Candles` edad de recepcion REST primaria. Book coincide
con Quote. Benchmark REST da p50/p95=0/0 para todos, max 1 ms salvo
DOGE/SUI/BNB/ADA donde max=0.

| Simbolo |   N | Gap               | Captura           | Quote             | Flow              | Candles          |
| ------- | --: | ----------------- | ----------------- | ----------------- | ----------------- | ---------------- |
| ADA     |  65 | 20589/23163/24967 | 16402/18398/21394 | 16524/18458/21499 | 18040/23170/24246 | 8709/10164/10577 |
| AVAX    |  64 | 21091/23374/25062 | 16527/19239/20757 | 16683/19344/20787 | 19492/24890/28160 | 8339/10326/11316 |
| BNB     |  66 | 20982/23592/24011 | 16221/18367/19490 | 16301/18475/19598 | 17393/19930/22304 | 8380/10560/11659 |
| BTC     |  67 | 20476/23635/25343 | 16176/18379/19135 | 16279/18507/19231 | 16633/19091/19840 | 8550/9934/10119  |
| DOGE    |  66 | 20826/23345/23868 | 16538/18670/19400 | 16597/18735/19449 | 17407/20867/25919 | 8342/10399/10951 |
| ETH     |  68 | 19840/22645/23906 | 15234/17460/19333 | 15313/17549/19423 | 15813/18146/20045 | 7920/9611/10781  |
| LINK    |  64 | 21289/23667/24571 | 16551/19807/20384 | 16594/19910/20422 | 19029/25296/34610 | 8236/10327/11624 |
| LTC     |  65 | 21115/23336/25165 | 16476/19021/19449 | 16541/19066/19544 | 18318/25235/33818 | 7955/9726/10033  |
| SOL     |  66 | 20313/23074/24092 | 15882/17729/18736 | 15981/17828/18793 | 16334/19055/19529 | 7904/9688/10184  |
| SUI     |  65 | 20925/23651/24510 | 16445/18378/19044 | 16547/18395/19073 | 17505/20381/23448 | 8073/9996/11101  |
| XRP     |  65 | 20933/22929/23593 | 16421/18647/19776 | 16500/18687/19868 | 16982/19827/20741 | 8463/10025/11527 |

### Lo Que No Se Puede Medir

No hay campos suficientes para p50/p95/max historicos de evento->recepcion,
actualizacion de buffer->inicio de decision, edad exacta de cada input al
terminar decision, closed-candle age del contexto original, BTC event age del
contexto a capture, enqueue/dequeue por endpoint, event-loop lag o duracion
CPU de strategy.evaluate. No se inventan ceros. Tampoco hay clock-offset
historico medido: consultar server time ahora no corregiria la ventana pasada.

Endpoint local a **2026-09-11T05:41:53.790Z**, fuera de la ventana: 10/11
simbolos FRESH; LTC tiene `LOW_ACTIVITY_OR_STALE_AGG_TRADE`, age 6709 ms.
Books HEALTHY, edades 97-234 ms, 33 streams activos, sin reconnects ni
rate-limit events; candles WS 5m alineados, 319 cerrados por simbolo.
Blackbox: 11863 observaciones escritas, failed=0, pendingWrites=0 y
peakPendingWrites=1. Es estado puntual, no percentiles historicos ni prueba
de que el camino REST de Micro fuera igualmente fresco. `pendingWrites` no
es longitud de la cola REST. El endpoint no expone event-loop p95.

### Ventanas Separadas

| Evidencia                                              | Ventana                                  |   N | Calidad | BTC posterior | Pasa comunes | ENTRY_INTENT | Gap mixto p50 |
| ------------------------------------------------------ | ---------------------------------------- | --: | ------: | ------------: | -----------: | -----------: | ------------: |
| Principal nueva                                        | 2026-09-11 05:05-05:35 UTC               | 721 |     115 |            43 |          563 |            0 |      20802 ms |
| Comparacion medida al inicio de esta auditoria         | 2026-09-11 00:45-01:15 UTC               | 719 |      80 |            42 |          597 |            0 |      20618 ms |
| Cifras anteriores aportadas por el usuario, HISTORICAS | rango exacto no aportado/revalidado aqui | 767 |      95 |            42 |          630 |            0 |      19860 ms |

La comparacion 00:45-01:15 tenia 351 primeros rechazos de nivel por cada lado:
285 resistance absent, 48 support absent, 18 ambos presentes, 0 both absent.
Su captura local p50/p95/max era 15993/18854/25054 ms y gap mixto
10946-30461 ms. Ningun lado paso el trigger.

Las cifras historicas del usuario (312 niveles, 292 resistencia ausente,
8 soporte ausente, 12 ambos, 9 SHORT post-trigger y diferencia 11.38-25.40 s)
**no son mediciones nuevas**, ni se combinan con las otras ventanas. Sin rango
exacto no se atribuye causalmente aquel 11-25 s a una fraccion especifica de
cola/red. El mecanismo de espera actual esta comprobado por separado.

## 6. Pruebas Y Replay

### Tests Existentes Offline

Comando ejecutado, un solo worker y cache desactivada:

```sh
AEGIS_ENABLED=false ./node_modules/.bin/vitest run src/strategies/micro-burst/domain/MicroBurstReactionEntryPolicy.test.ts src/strategies/micro-burst/domain/MicroBurstSupportResistance.test.ts src/strategies/micro-burst/domain/MicroBurstContextBuilder.test.ts src/strategies/micro-burst/domain/BtcMicroContextProvider.test.ts src/core/strategy/StrategyRouter.test.ts src/core/market-data/MarketSnapshotProvider.test.ts src/core/market-data/MarketDataCandleProvider.test.ts --maxWorkers=1 --no-file-parallelism --no-cache --reporter=dot
```

Resultado: **152 tests pasados, 7 archivos**, 2.01 s; inicio 05:44:54 UTC.
No es la suite completa, ni una prueba LIVE. No se activo Aegis.

### Contratos Diagnosticos Aislados

`/tmp/opencode/micro-diagnostic-contracts.cjs` importa modulos puros y fixtures
por ts-node transpileOnly; no importa main, dotenv ni adaptadores con bootstrap.
No usa red ni almacenamiento operativo. Datos de precio y reloj son sinteticos,
no ADA/BTC/ETH historicos. Los fixtures directos de politica no sustituyen una
validacion end-to-end por el context builder.

```sh
AEGIS_ENABLED=false node --test --test-concurrency=1 /tmp/opencode/micro-diagnostic-contracts.cjs
```

Resultado intencionalmente no verde: **13 tests, 9 pasan, 4 fallan**, 724.22 ms,
exit no cero. Las expectativas fallidas no se cambiaron para ocultar resultados.

| Test | Contrato                                                             | Resultado / significado                                                                                  |
| ---- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A1   | Falta resistance                                                     | PASS, NO_TRADE y null original; etiqueta temporal no distingue ausencia                                  |
| A2   | Falta support                                                        | PASS, fail closed                                                                                        |
| A3   | Target presente disponible despues del trigger                       | PASS, rechazo de confirmacion                                                                            |
| A4   | Break y retest deben ser candles distintas                           | PASS, un break solo no entra; al agregar break anterior aparece BREAKOUT_RETEST_CONTINUATION             |
| A5   | Precio entre niveles lejanos                                         | PASS, ambos lados NOT_NEAR                                                                               |
| A6   | BTC event viejo con recepcion fresca                                 | PASS, BTC_UNAVAILABLE                                                                                    |
| A7   | Book fresco y contexto viejo                                         | PASS, SNAPSHOT_EXPIRED cuando se entrega el reloj actualizado                                            |
| C8   | Reclaim valido pero mala economia neta                               | PASS; control ENTRY_INTENT, target reducido a 100.8 termina NET_ROOM_INSUFFICIENT                        |
| A9   | REST cruza boundary respecto al as-of congelado                      | PASS, candle_in_future; reproduce contrato, no demuestra que cada caso real sea esa carrera              |
| B1   | Probar defensa confirmada alternativa ante nearest tardio            | FAIL: NO_TRADE en vez de ENTRY_INTENT; seleccion unica antes de validacion                               |
| B2   | Reorientar target cruzado al siguiente opposing level                | FAIL: NO_TRADE en vez de ENTRY_INTENT; nearest original conservado                                       |
| B3   | Observer demorado no puede entrar con reloj anterior                 | FAIL: ENTRY_INTENT en vez de NO_TRADE despues de avance controlado de 90 s                               |
| B4   | Preservar disponibilidad del mismo precio al agregar pivot posterior | FAIL: availableAt pasa de 1699999579999 a 1699999759999, +180000 ms; no autoriza conservar fuerza futura |

C8 publica executablePrice=100.01, coste residual=14 bps,
netRoom=62.976302369762 bps, netRR=0.969837422661 < 1.5 y stressedNetRR=
0.620464437542. La formula usa destino acotado por 2 bps, resta costes al room
y los suma al riesgo. No suma spread otra vez porque usa quote ejecutable.
Es una restriccion economica sintetica diferente de los dos ETH reales, que
fallaron antes, por room bruto.

B1/B2 especifican una seleccion alternativa deseada que debe revisarse como
contrato de estrategia; prueban el mecanismo de rechazo, no rentabilidad de
la alternativa. B3 es el riesgo de frescura mas directo. B4 puede ser una
decision conservadora de versionado, pero carece de diagnostico que distinga
esa decision de una defensa nunca disponible.

### Limites Del Replay

La composicion actual publica features de candles 1m y benchmark, no todas
las candles 1m/3m/5m, niveles con timestamps, executionBook original y contexto
inmutable. `MicroBurstStrategy.ts:66-75` no adjunta `strategyInputReplay`.
El compactor (`StrategyDecisionBlackBox.ts:258-300`) no puede inventarlo.
`market_archive` y `prospective_validation` estan desactivados en la config
efectiva y el boot lo confirma. El directorio de archivo contiene material
historico, por ejemplo depth ADA del 4 de septiembre; su existencia no demuestra
cobertura exacta de la ventana actual.

Se pudieron reconstruir fielmente los **diagnosticos publicados** de los casos
anteriores y unir cada decision a su snapshot observacional. No se ejecuto un
replay exacto de decisiones historicas: faltan los inputs originales. Usar los
datos capturados tras construir el contexto, o descargar ahora OHLC historico,
seria **NONEXACT** respecto al book, caches, BTC, timestamps de disponibilidad,
precio contextual y structuralClarity originales. No se genero un dataset
fabricado, ni se conto un resultado recomputado como decision real.

## 7. TODO Priorizado

Solo propuestas, **ninguna implementada**:

| Prioridad | Cambio minimo propuesto                                                                                                                                                                                                             | Regresion / validacion necesaria                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1        | Sacar las lecturas REST observacionales del camino critico; observar el input inmutable ya construido, con cola de evidencia acotada. Si permanece algun await, revalidar frescura con reloj actual antes de estrategia/admission.  | B3 con observer lento/colgado/error, libro actualizado durante await, limites de 30/60 s y ausencia de efectos en decision/admission; no perder fail-closed |
| P1        | Definir una sola politica de referencia para candidatos y target, con precio ejecutable y disponibilidad as-of trigger. Recalcular target tras role reversal y excluir el propio nivel roto.                                        | B2, espejo SHORT, target cruzado, empate, next opposing confirmado/no confirmado, geometria y room/RR netos sin relajar                                     |
| P2        | Validar disponibilidad y orientacion antes de elegir nearest; decidir explicitamente si se permite otra defensa cuando la primera falla.                                                                                            | B1, alternativa confirmada y alternativa futura, multiples candidatos, no escoger retrospectivamente el que gano                                            |
| P2        | Versionar clusters para conservar solo precio/fuerza/touches disponibles as-of, sin sustituir max timestamp por min indiscriminadamente.                                                                                            | B4, nuevo pivot mismo precio, cluster que se mueve, fuerza que cruza umbral, ventana que expulsa el pivot viejo, invariancia ante datos posteriores         |
| P2        | Evitar REST redundante en contexto y observacion usando snapshots cerrados compartidos y coherentes; medir antes de cambiar cache/colas.                                                                                            | Carrera de cambio de minuto A9, coherencia 1m/3m/5m, snapshot server anterior a respuesta, gaps y cierre inclusivo                                          |
| P2        | Publicar razones separadas ABSENT, PRESENT_NOT_AVAILABLE, INVALID, WRONG_SIDE_OR_EQUAL y TOO_FAR; conservar firstReject junto a checks ejecutados.                                                                                  | Recuento disjunto y solapado sin duplicar commonGuard; 8 both-missing verificados directamente                                                              |
| P2        | Registrar family candidata al reconocer patron aun si luego falla geometria/coste, y estado UNCLASSIFIED antes de reconocerlo.                                                                                                      | ETH post-trigger sin family no debe ser clasificado por inferencia; separar patron detectado de entrada elegible                                            |
| P2        | Instrumentar spans monotonic/local/server y origen de cada dato: requested/enqueued/dequeued/response/contextBuilt/evaluationStarted/evaluationFinished/recordCreated/flush, E/T/recv/watermark/lastClosed/availableAt/triggerOpen. | p50/p95/max por simbolo y fuente; explicit clock-offset bounds, ticks saltados y event-loop delay; no renombrar capturedAt como decisionFinished            |
| P3        | Conservar muestra acotada de inputs originales con hash/config/artifact e IDs de candles/niveles, sin datos sensibles ni captura mutante.                                                                                           | Replay exacto cronologico y anti-lookahead; comparar con el snapshot observacional sin sustituir el original                                                |
| P3        | Evaluar oportunidades economicas y cambios de seleccion fuera de muestra, con costes/latencia ejecutables y purga temporal.                                                                                                         | No bajar room/RR, ampliar lookback ni alterar thresholds basandose solo en estos 30 minutos o en los fixtures                                               |

No se propone clear/restart/reset del ledger ni aumento de riesgo para resolver
NO_TRADE. La admission de una futura senal sigue teniendo que respetar todas
las barreras de identidad, cuenta, sizing, ordenes y estado durable existentes.

## 8. Apendice Reproducible

### Comandos De Lectura

```sh
git status --short
git branch --show-current
git rev-parse HEAD
git log -5 --oneline
git rev-parse refs/remotes/origin/work/micro-burst-rider-v1-20260826
git ls-remote origin refs/heads/work/micro-burst-rider-v1-20260826
date -u +%Y-%m-%dT%H:%M:%SZ
pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.stringify(JSON.parse(s).filter(p=>p.name==="01-Trading-Bot").map(p=>({name:p.name,pid:p.pid,status:p.pm2_env.status,uptime:p.pm2_env.pm_uptime,exec:p.pm2_env.pm_exec_path})))) )'
ps -p 47506 -o pid,lstart,etime,comm
curl --max-time 5 --silent --show-error http://127.0.0.1:8010/diagnostics/market-data
node /tmp/opencode/micro-artifact-diagnostic.cjs
node /tmp/opencode/micro-levels-timing-audit.cjs
node /tmp/opencode/micro-audit-supplement.cjs
sha256sum regime_config.live.yaml
git diff --check
git diff --stat
git diff --cached --stat
```

El primer analizador tambien acepta inicio/fin como argumentos para repetir la
ventana de comparacion. Las lecturas ordinarias de source/docs/directorios se
hicieron con Read/Grep/Glob. La I/O de Node se limito a agregacion JSONL,
hashing/transpilacion en memoria y carga de modulos puros para tests.

Una primera ejecucion de la ampliacion del agregador fallo al abrir el close
journal vacio con `end=-1`. Se corrigio exclusivamente el script temporal para
contar un archivo vacio como cero registros y se repitio con exito. No se
altero el journal ni se conto esa ejecucion fallida como validacion.

### Manifiestos De Lectura Principal

Son hashes del prefijo de bytes leido, no del archivo mutable en cualquier
instante posterior. Repetir el rango logico debe mantener los conteos mientras
se retengan sus registros, aunque el hash del archivo creciente cambie.

| Fuente                 | Bytes congelados | Lineas | SHA-256                                                            |
| ---------------------- | ---------------: | -----: | ------------------------------------------------------------------ |
| decisions-v2.jsonl     |        151915838 | 112255 | `1f7f4a858c969fecac17ab2d44c73ef46305e02b0cb8ea4cd0d9e07e4162b183` |
| snapshots-v2.jsonl     |        259730690 |  74548 | `5eb69c467f65ac19e28311b3afff29c9ecef59943be9f84e49536ed1f52b0547` |
| history-2026-09-10.log |          4427346 |   9147 | `de182435ccb50dfb24703494d3ef772919662d4ef5444ddcd0971792462d17cd` |
| history-2026-09-11.log |          4736693 |   9363 | `026fd167252ce21c53c5e2321a9ab78bf6d441d02789c577c63e26c48c794ea0` |

Resultado completo inicial retenido por la herramienta:
`/home/jasan/.local/share/opencode/tool-output/tool_08e10a15e0019L0JVmz2OCUMhb`.
Resultado principal retenido:
`/home/jasan/.local/share/opencode/tool-output/tool_08eff6577001XOiCujJeUVSNNq`.
El suplemento analiza ese resultado y el prefijo de decisiones declarado;
no necesita volver a leer todo el archivo de snapshots. Son artefactos locales
temporales, no archivos versionados ni una API estable.

### Fixtures Y Hashes

| Archivo temporal               | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| micro-levels-timing-audit.cjs  | `e0be2326a4a3b36928b65461a34ef6bfe33b1bb619657447a3f40e9e7974f6fb` |
| micro-diagnostic-contracts.cjs | `282887b98179da166c5d72ff09a1ecdc128213301a18fb360b9c5bf309629540` |
| micro-artifact-diagnostic.cjs  | `8219da77cf7b5772c85bbc81c1a9a4e361ff39a84b85cddbdccffeb049501c32` |
| micro-audit-supplement.cjs     | `5401d4177ddc8c040b93fd66fa387ec763fc905fb610ebf9bf8fd3ff5af72da7` |

SHA-256 instalados de modulos clave, con coincidencia de transpilacion en memoria:

| Modulo bajo dist                                               | SHA-256 JS                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| main.js                                                        | `d549722dc696e0b03f930e8c77c9c89da488f3a9f819eaabb206386bb19790da` |
| core/strategy/StrategyRouter.js                                | `e05fd2add4b99abfc333f36b448bc8dd2ab87b543d690c317635e3feff6f5347` |
| core/market-data/MarketSnapshotProvider.js                     | `628ecfe744d62435fe238e71ea9fdec97866fbe4d439e45f9217d83d4e6c3c96` |
| strategies/micro-burst/domain/MicroBurstSupportResistance.js   | `d228c89b5a1d966ac2cbfe379e51b75d5d0c6195938be5e905af62ad4151e190` |
| strategies/micro-burst/domain/MicroBurstReactionEntryPolicy.js | `6f1551afcc1a373a42885e00f5201bb2077127fd2635775053f0deb3e5dc28c0` |
| strategies/micro-burst/domain/MicroBurstContextBuilder.js      | `0838906cd202980319376fdd9e1b7d60c2978c01a687b29bf8b5445884a8699c` |
| strategies/micro-burst/application/MicroBurstEvaluator.js      | `8d638c62b530b712494bc44c8489ac64ddfb9978b76899e99bb8195814d16f2c` |
| strategies/micro-burst/application/MicroBurstRuntime.js        | `4a4e62ed41c49c8706eb5dd59204b7eeafebec9e62c2d01ff85850167360ba8a` |
| infra/adapters/BinanceAdapter.js                               | `95cbf9f4a5cdb6df08b169039fed37e3fd1371bf4e65d841553c46c58346a295` |

El script de artefactos enumera y emite los hashes de los 21 modulos, no solo
los nueve resumidos aqui. No hubo compilacion a `dist`.

## 9. Cierre

Verificacion final a 2026-09-11T05:55:14Z: HEAD sin cambios en `8c04b21...`,
staging vacio y `git status --short` muestra exclusivamente este informe nuevo.
`git diff --check` no reporta errores en archivos tracked. Repetida la comprobacion
de artefactos: 21/21 coincidencias, 0 discrepancias y mismo hash efectivo;
el hash del YAML sigue siendo el inicial. Los archivos operativos pueden seguir
recibiendo escrituras del bot, pero esta auditoria no los modifico.

Se verificaron personalmente codigo, datos y tests; se publican contratos de
niveles con casos reales, metricas temporales con dominios explicitos, embudo
de ausencia de entradas, TODO priorizado y limites de inferencia. Los huecos
principales pendientes son replay exacto, prevalencia de los defectos sinteticos,
spans de latencia y atestacion completa del artefacto cargado.

La evidencia no justifica operar con niveles ausentes, considerar una mecha
posterior como senal perdida, bajar room/RR o desbloquear estado durable. Si se
autoriza una correccion futura, primero debe resolverse el contrato temporal y
la coherencia de seleccion con regresiones y evaluacion cronologica fuera de muestra.

## 10. Implementacion Posterior Autorizada, 2026-09-11

### Procedencia Y Limites Operativos

Base local y remoto verificados mediante fetch normal:
`8c04b214616cdc8d3975143b2691b7cfb9c9ad4b`, rama
`work/micro-burst-rider-v1-20260826`. Al inicio solo estaba sin seguimiento este
informe. Se conservaron sus secciones historicas. El baseline completo se fijo en
un worktree **detached**, sin crear rama, en
`/tmp/opencode/micro-implementation-baseline-8c04b21`, con dependencia local
`node_modules` enlazada, sin instalar terceros ni reemplazar source del workspace.

No se hizo deploy, restart, bootstrap de main, consulta de cuenta/exchange ni envio
de orden real. No se modificaron `.env`, YAML LIVE, `dist`, costes, presupuesto,
leverage, umbrales, lookback, pivots, aprobaciones, locks, cuarentena, ordenes ni
estado de cuenta. **Existe una excepcion a la restriccion de journals que debe
declararse, no ocultarse**:

- La primera suite ampliada incluyo tests preexistentes de `MicroBurstRuntime`
  que construian el signal journal con su directorio por defecto.
- Escribieron una fila sintetica cada uno en
  `logs/micro-burst/shadow-signals/2026-09-11-1789113398078.jsonl` y
  `logs/micro-burst/shadow-signals/2026-09-11-1789113398220.jsonl`.
- Se comprobaron por lectura: `shadowSignalId=live-signal` y `runtime-golden`,
  `cohortId=UNOFFICIAL`, `codeCommitSha=UNKNOWN`, `snapshotAtMs=1000`, precio 100,
  `liveExecution=false`. Los puertos de ejecucion eran mocks.
- Se informo de inmediato. No se borraron, reescribieron, movieron ni versionaron
  esos archivos. No son decisiones reales ni parte de la ventana historica.
- El fixture de runtime ahora usa un journal temporal y un shadow journal en
  memoria. Los tres tests research que usaban carpetas bajo `src` tambien usan
  directorios temporales. Un preload impide posteriores escrituras en el workspace
  y conexiones de red. No se afirma que toda la sesion cumpliera el limite de journals.

`src/testing/OfflineTestBootstrap.cjs` desactiva las dos entradas de dotenv antes
de los imports, elimina credenciales y bloquea conexiones. El runner separado
`src/testing/OfflineVitest.config.ts` agrega mocks de `dotenv` y `dotenv/config`;
su setup elimina credenciales y fija Aegis false. Los comandos usan `env -i`,
`DOTENV_CONFIG_PATH=/dev/null`, HOME/TMPDIR temporales y `--configLoader runner`
para evitar que Vite escriba un bundle de configuracion en el workspace.
Las pruebas de persistencia usan archivos temporales; las de cuenta usan mocks.

### Tabla De Implementacion

Todos los cambios de esta tabla pertenecen al commit de implementacion
`e1bbd7da23a93f6ce73226b6446beb2d3527ab63` (`fix Micro temporal selection and exact decision evidence`).
No se confunde ese commit con una aprobacion de artefacto LIVE.

| Alcance                          | Implementacion / funcion                                                                                                                                                                                                                                                                         | Regresion y resultado final                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Espera observacional          | `StrategyRouter.evaluate`, `MicroBurstBlackBoxObservation.createMicroBurstBlackBoxObservation`: ruta opt-in de captura sincronica de inputs exactos y enqueue posterior; no pide nuevas candles REST                                                                                             | `MicroBurstTemporalContracts.test.ts`: decision resuelta con writer bloqueado, cero llamadas al candle port, evidencia independiente de mutaciones posteriores; PASS                                 |
| 2. Frescura y relojes            | `MicroBurstEvaluator.evaluate`, `MicroBurstStrategy.afterObservationWait`, `MicroBurstReactionEntryPolicy.evaluateMicroBurstReactionEntry`: exchange-time acotado por request/response y elapsed monotonic; recepcion local del book por separado; no cambia timestamp original de contexto/book | B3 con reloj monotonic inyectado que avanza 90 s: antes ENTRY_INTENT, despues NO_TRADE; PASS                                                                                                         |
| 3. Defensas alternativas         | `MicroBurstReactionEntryPolicy`: lista completa permitida, orden determinista por distancia/disponibilidad/tipo; intenta otra defensa tras disponibilidad, lado, proximidad, trigger o deterioro invalidos; no busca una economia mejor saltando una defensa cualificada                         | B1 LONG/SHORT, wrong-side y all-bad, misma proximidad; PASS                                                                                                                                          |
| 4. Target ejecutable             | Misma funcion: obstaculo del tipo opuesto mas cercano por delante del ask/bid, confirmado al as-of; despues exige disponibilidad anterior al trigger                                                                                                                                             | B2 LONG/SHORT, target cruzado, closer obstacle con room insuficiente y closer obstacle confirmado despues del trigger; PASS, sin saltar al lejano                                                    |
| 5. Clusters temporales           | `MicroBurstSupportResistance.detectSupportResistance` / `clusterPivots`: snapshots completos e inmutables en cada confirmacion; precio, touches, fuerza y volumen existen en su version                                                                                                          | B4 conserva exactamente el estado historico anterior al nuevo pivot, mientras la version actual cambia precio/fecha; duplicados, desorden y gaps rechazados; PASS                                    |
| 6. Evidencia acotada y durable   | `BoundedObservationQueue`, hook `requiredAudit`, `MicroBurstRuntime.stop`, `MicroBurstEvaluator`                                                                                                                                                                                                 | Caps bytes/records/in-flight, overflow, errores, drain y timeout, buffers mutados y sparse arrays; requerido ACK no puede eludirse por drop; PASS. Replay completo excluido de metadata de ejecucion |
| 7. Diagnosticos y compatibilidad | Trazas reales en politica y callback de etapas en `MicroBurstEntryPolicy`; `StrategyDecisionBlackBox` conserva full replay Micro; enriquecimiento generic posterior solo desde inputs congelados; completion JSONL separado                                                                      | Generic router/blackbox/features/sink y schema existentes; PASS. No se relabela el calculo de features posterior como input original                                                                 |
| 8. Replay offline                | `MicroBurstExactReplay`, `MicroBurstExactReplayCli`: schema, revision de evaluador, commit, config completa, presencia explicita de fuentes, tipos y campos requeridos                                                                                                                           | Replay determinista de inputs completos, rechazo de legacy/incompletos/mismatch y CLI readonly con fixture temporal; PASS                                                                            |

### Contratos Revisados, Sin Relajacion Economica

Antes de editar source se ejecuto otra vez el script original
`/tmp/opencode/micro-diagnostic-contracts.cjs`, con entorno vacio y bootstrap dotenv
temporal: **13 tests, 9 PASS, 4 FAIL**, 517.11 ms. Se conservaron esas expectativas
y el resultado fallido como reproduccion del baseline.

Las regresiones versionadas explicitan ajustes necesarios al contrato diagnostico:

- B1/B2 son la politica de seleccion ahora autorizada por el usuario, no prueba de
  rentabilidad ni de prevalencia en la ventana real. Los fixtures nuevos mantienen
  coherencia entre `levels.levels` y `nearest`. Cambiar solo `nearest` en un fixture
  con otra lista completa no representa ausencia global de soportes/resistencias.
- La expectativa original de B3 avanzaba una variable `wall` que no estaba conectada
  al reloj de la estrategia. La regresion conecta el reloj monotonic del router y
  prueba el rechazo despues de la espera. La ruta exacta evita esa espera REST.
- B4 no cambia `max(availableAt)` por `min`. Se conserva el snapshot historico completo,
  y la version fortalecida/desplazada tiene su fecha nueva. La defensa usa la ultima
  version disponible antes del trigger; la version actual no destruye esa historia.
- Role reversal conserva ruptura cerrada posterior a disponibilidad y anterior a
  una candle de retest distinta. No se permite que la ruptura sea su propio retest.
- El target mas cercano confirmado al as-of bloquea aunque no estuviera disponible
  antes del trigger: no se lo elimina para escoger uno lejano con mejor RR.
- Sigue habiendo room bruto >=30 bps, RR >=1.5, coste residual 14 bps y buffer 2 bps.
  El lookback sigue siendo 20 barras 5m, pivots estrictos 3/3 y proximidad 50 bps.
  El contexto sigue pidiendo 100/80/60 candles. Riesgo 90%, tiers 20/30 y regla diaria
  de tres perdidas no se editaron. Tampoco se modifico el protocolo PREPARED.

`firstReject` de cada intento es su primer check fallido; `firstCandidateReject`
conserva el primero entre candidatos y `candidatesVisited` permite distinguirlo
del candidato final. La etiqueta resumen por lado no pretende enumerar checks
que nunca se ejecutaron. Las etapas comunes se registran tambien, en orden real.
Los motivos detallan ausencia, disponibilidad, lado/igualdad, distancia, trigger,
deterioro, geometria, room bruto, RR bruto y netos. `targetSelection` conserva el
target de referencia, si estaba cruzado y la regla aplicada al precio ejecutable.

### Flujo Exacto Y Dominios Temporales

1. Se mide inicio/fin de la lectura inicial de server time y su intervalo monotonic.
   El sample server cae dentro de ese intervalo. Se usa una cota superior conservadora
   de exchange-now para frescura; no se presenta Date.now como server time.
   Un `snapshotAtMs` suministrado por un caller se declara `CALLER_DECLARED_AS_OF`.
2. Cada respuesta de candles se copia al recibirse, antes de esperar las otras series.
   Se conservan inputs raw/preparados y config completa del builder. Su reloj local
   de calidad se sigue consultando despues de completar las lecturas asincronas.
3. El book original del builder se copia y reutiliza como executionBook. No se vuelve
   a consultar otra cotizacion para fabricar evidencia del input anterior.
4. El router captura profundamente el contexto, mide capture local/monotonic y
   evalua. Tras cualquier espera legacy refresca solamente los relojes de evaluacion,
   no los timestamps de fuentes ni la identidad del episodio.
5. Se encola decision/input original. La copia reutiliza solo arboles producidos y
   congelados recursivamente por `copyObservation`; un Object.freeze superficial de
   otro caller no es suficiente. Se rechazan getters, ciclos, tipos no soportados,
   sparse arrays, exceso de nodos/profundidad y de bytes.
6. El writer serializa fuera del camino de evaluacion. Features generic de quote,
   depth y flow se derivan exclusivamente de esos inputs, con procedencia explicita
   `POST_EVALUATION_FROM_EXACT_INPUTS`. Candles/benchmark generic no capturados quedan
   NOT_REQUESTED; el replay conserva las candles originales y el contexto BTC usado.
7. El registro de decision conserva evaluationStarted/evaluationFinished locales y
   duracion monotonic. El inicio de persistencia va en diagnostics. Tras ACK del sink
   se publica otro schema `DECISION_PERSISTENCE_TIMING` en `<decisions>.timing.jsonl`,
   con decisionId, inicio/fin y duracion monotonic. No es otra decision, ni una
   atestacion de fsync. La duracion de codificacion del replay se mide separadamente.
8. La admission y el coordinador durable conservan sus checks y PREPARED. El test
   de expiracion durante PREPARED y su nuevo espejo de target cruzado antes del send
   verifican que no se invoca el port. La observacion full no sustituye ese journal.

Hay limite de **16 records**, **8 MiB contabilizados totales**, **2 MiB por record**,
100.000 nodos y profundidad 32. In-flight cuenta hasta que el sink termina. No hay
una promesa nueva esperando por cada evento descartado: el writer es serial.
Health expone accepted/written/dropped/failed, pending/peak records/bytes y tiempos
de cola/escritura. Shutdown sella la cola; despues de 5 s de sink colgado descarta
pendientes y declara `drainTimedOut`, manteniendo contabilizado el unico in-flight
que no puede cancelar. Ese limite observacional no altera un timeout de trading.

Campos no disponibles siguen explicitamente ausentes/null: E/T originales de depth
cuando el snapshot port no los entrega, recepcion del watermark aggTrade y
enqueue/dequeue internos del adaptador REST. No se fabrican ceros ni se usa una
consulta nueva para reconstruirlos. `inputSources.timing` conserva los boundaries
que realmente mide el builder. Las diferencias local/server historicas siguen sin
ser una medicion pura de latencia.

### Replay Y Comparacion Antes/Despues

El nuevo schema interno `MICRO_EXACT_INPUT`, version 1, no es una nueva marca de
estrategia. Conserva commit, revision de evaluador, config completa, contexto,
candles por timeframe, niveles/historia, book, flow, BTC, precios, calidad y relojes.
`sourcesPresent` distingue fuente legitimamente ausente de campo truncado. Los
numeros no finitos se codifican con tags explicitos, nunca como null silencioso.
La CLI rechaza source sucio, un HEAD distinto del commit solicitado, otra revision
de evaluador, legacy o inputs incompletos **antes de evaluar**. La procedencia es
de ese checkout, no una certificacion del artefacto que genero datos historicos.

Ejemplo offline sobre un checkout limpio del commit registrado, sin importar main:

```sh
env -i PATH="$PATH" HOME=/tmp/opencode TMPDIR=/tmp/opencode \
  NODE_OPTIONS="--require=$PWD/src/testing/OfflineTestBootstrap.cjs" \
  DOTENV_CONFIG_PATH=/dev/null AEGIS_ENABLED=false \
  node -r ts-node/register src/tooling/micro-burst/MicroBurstExactReplayCli.ts \
  /tmp/opencode/complete-record.json COMMIT_SHA_DEL_REGISTRO
```

No se hizo replay exacto nuevo de las 721 decisiones historicas: no adquirieron
inputs completos por implementar este schema. No se sustituyeron por capturas
posteriores ni se descargo OHLC para llamarlo exacto. No habia un nuevo registro
operativo completo de este schema disponible para este bloque sin desplegarlo.

`/tmp/opencode/micro-implementation-compare.cjs` importa el evaluador anterior desde
el baseline congelado y el actual desde source. Ambos reciben **el mismo objeto
completo e inmutable** de inputs sinteticos para la funcion pura. Es una comparacion
de decisiones, no un backtest de mercado ni una reconstruccion del context builder.
Cada fila siguiente tiene un caso LONG y un caso SHORT, 16 inputs en total:

| Caso sintetico                                   | Antes por lado | Despues por lado | Causa                                           |
| ------------------------------------------------ | -------------- | ---------------- | ----------------------------------------------- |
| Control                                          | ENTRY_INTENT   | ENTRY_INTENT     | Reclaim y economia validos                      |
| Primary tardio                                   | NO_TRADE       | ENTRY_INTENT     | Otra defensa cercana disponible                 |
| Primary wrong-side                               | NO_TRADE       | ENTRY_INTENT     | Otra defensa con orientacion valida             |
| Target de referencia cruzado                     | NO_TRADE       | ENTRY_INTENT     | Reorientacion al siguiente opposing level       |
| Obstaculo cercano                                | ENTRY_INTENT   | NO_TRADE         | No saltar el room insuficiente                  |
| Obstaculo cercano confirmado tarde               | ENTRY_INTENT   | NO_TRADE         | No saltar su indisponibilidad antes del trigger |
| Todas las defensas tardias                       | NO_TRADE       | NO_TRADE         | Mantener confirmacion                           |
| Obstaculo intermedio con coste neto insuficiente | ENTRY_INTENT   | NO_TRADE         | Mantener RR neto                                |

**8 intenciones antes, 8 despues**, con composicion diferente. No implica mas trades
reales ni mejores resultados. Artefacto completo, inputs y outputs:
`/tmp/opencode/micro-implementation-complete-inputs.json`, SHA-256
`dd2912ecd777ddd0647ecff561d2595d0b6392d4a64df7c4eecc9b474efe1356`.
Resumen en `/tmp/opencode/micro-implementation-comparison.json`.

Benchmark sintetico separado, 200 repeticiones, snapshot con 100/80/60 candles y
20 niveles de depth por lado; JSON 43.208 bytes, accounting conservador 277.520 bytes:

| Duracion monotonic, ms      |   p50 |   p95 |   Max |
| --------------------------- | ----: | ----: | ----: |
| Deep copy de fuente mutable | 0.901 | 1.779 | 9.397 |
| JSON serialization          | 0.158 | 0.298 | 1.669 |
| Evaluacion pura             | 0.062 | 0.180 | 0.993 |

Percentil nearest-rank. En 100 enqueue con writer retenido: 16 aceptados, 84 drops,
peak 16 records / 4.440.320 bytes contabilizados. RSS del proceso paso de
163.168.256 a 183.091.200 bytes; es un proxy del proceso Node/ts-node, no heap
retenido de la cola ni una medicion de produccion. Una primera ejecucion del script
ampliado fallo por una llave de cierre omitida; se corrigio el script temporal y
solo la ejecucion completa posterior produjo estos resultados. No se comparan
estos milisegundos sinteticos con los 16-21 s historicos para prometer una mejora LIVE.

### Pruebas Ejecutadas Y Fallos Intermedios

Todas las suites finales usaron un worker, sin file parallelism ni cache, entorno
vacio y el runner/preload aislados. No hubo activacion de Aegis. Comando base:

```sh
env -i PATH="$PATH" HOME=/tmp/opencode TMPDIR=/tmp/opencode \
  NODE_OPTIONS="--require=$PWD/src/testing/OfflineTestBootstrap.cjs" \
  DOTENV_CONFIG_PATH=/dev/null AEGIS_ENABLED=false \
  ./node_modules/.bin/vitest run \
  --config src/testing/OfflineVitest.config.ts --configLoader runner \
  RUTAS_DE_LA_SUITE --no-cache --reporter=dot
```

| Ejecucion                                             | Resultado real                                                                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repro inicial aislada del baseline                    | 13 tests: 9 PASS, 4 FAIL esperados; 517.11 ms                                                                                                                                             |
| Primer bloque queue/levels/reaction                   | 29 tests: 23 PASS, 6 FAIL; incoherencia de fixtures nearest/lista y validacion de future candles                                                                                          |
| Router y niveles siguiente                            | 36 tests: 35 PASS, 1 FAIL; timestamps observacionales agregados al router generic cambiaban igualdad. Timing quedo opt-in exact                                                           |
| Primer no-emit ampliado                               | FAIL por contrato close void/Promise del observador Momentum; interfaz compatible con ambos, sin cambiar su estrategia                                                                    |
| No-emit de fixture nuevo                              | FAIL por buyVolume ausente; fixture completado. Otra ejecucion detecto Array.at incompatible con ES2020; se uso indice, sin cambiar tsconfig                                              |
| Primera ampliacion domain/runtime                     | 495 tests: 493 PASS, 2 FAIL; instrumentacion habia cambiado semantica del callback local/determinismo. Se separo timingClock opcional; hubo la incidencia de dos journals descrita arriba |
| Ampliacion bajo bloqueo de escrituras                 | 811 tests: 789 PASS, 22 FAIL en 3 suites research; el preload bloqueo sus carpetas bajo src. Fixtures migrados a tmp, sin desactivar la proteccion                                        |
| Integracion y fixtures corregidos                     | 217/217 PASS en 13 archivos, 71.34 s                                                                                                                                                      |
| Suite final Micro/blackbox/durable/market-data/replay | **837/837 PASS, 59 archivos**, 100.88 s, inicio 14:57:15                                                                                                                                  |
| Integracion final cuenta/ejecucion                    | **162/162 PASS, 7 archivos**, 67.43 s, inicio 15:00:46                                                                                                                                    |
| Checkpoints estaticos finales                         | **5 PASS, 15 skipped**, 1 archivo, 438 ms; seleccion explicita, no ejecucion de los casos Aegis                                                                                           |
| Compilacion final                                     | `tsc --noEmit` PASS; ninguna emision a dist                                                                                                                                               |
| Whitespace                                            | `git diff --check` PASS                                                                                                                                                                   |

Las tres selecciones finales son disjuntas: **1.004 tests pasados en 67 archivos**,
con 15 casos no seleccionados dentro del archivo de checkpoints. No se suman las
ejecuciones anteriores ni se presentan los intentos fallidos como verdes.

Rutas de la suite de 837: `src/strategies/micro-burst`,
`src/core/strategy/StrategyRouter.test.ts`, `src/core/blackbox`, y los tests
`CandleIntegrity`, `SynchronizedOrderBook`, `RollingAggTradeBuffer`,
`SharedNeutralMarketFeatures`, `MarketSnapshotProvider` bajo `src/core/market-data`;
`src/infra/logging/JsonlDecisionEvidenceSink.test.ts`,
`src/tooling/micro-burst/MicroBurstExactReplayCli.test.ts`, los cuatro tests
`DurableEntryCoordinator`, `DurableCloseCoordinator`, `DurableStopCoordinator`,
`SharedStrategyExecutionService` bajo `src/app/execution`,
`src/infra/state/MicroBurstNetLossLedger.test.ts` y
`src/app/position/MicroEntryRecoveryService.test.ts`.

Rutas de la suite de 162: `TradingService.safety-contracts.test.ts`,
`TradingService.micro-settlement.test.ts`, `TradingService.contextual-flow.test.ts`
bajo `src/app/services`; `src/app/runtime/StrategyRuntimeCoordinator.test.ts`,
`src/app/bootstrap/MicroNetLossComposition.test.ts`,
`src/infra/adapters/BinanceAdapter.contextual-risk.test.ts` y
`src/infra/adapters/BinanceAdapter.brackets.test.ts`.

Seleccion estatica: `src/restoration/original-operational-semantics.test.ts` con
`-t 'operational sources|current-brain contract exception|branch bytes|out of the operational path|exit sources'`.
Pasaron sin editar ningun hash/checkpoint ni constante de aprobacion.
Se uso Prettier sobre los archivos source/tests modificados; el script
`npm run format` contiene `prettier --write .`, por lo que se evito su alcance global
para preservar archivos ajenos y operativos.

### Publicacion Y Validacion Operativa Pendiente

Este bloque es source/tests/docs. Un artefacto posterior necesita su propia revision
y aprobacion de commit/config, compilacion controlada y validacion operativa
autorizada. No se actualizo ninguna aprobacion para permitir ejecutar este source.
Siguen pendientes de una futura ventana autorizada las edades reales de cada fuente,
latencia y drops observados, cobertura del nuevo replay, RSS del proceso de trading
y comportamiento fuera de muestra. Los 721 casos, 115 rechazos de calidad y 43 BTC
del informe original siguen siendo historicos. No hay promesa de latency ni profit.

### Cierre De Publicacion Verificado

Al reanudar el bloque, el worktree y el staging ya estaban limpios y la implementacion
completa ya estaba publicada. `git fetch origin` confirmo **0 commits locales y
0 remotos divergentes** respecto a `origin/work/micro-burst-rider-v1-20260826`,
con HEAD `e1bbd7da23a93f6ce73226b6446beb2d3527ab63`. No habia los 22 archivos
modificados mencionados en el resumen de traspaso ni trabajo pendiente que recuperar.

Implementacion publicada:
[e1bbd7d](https://github.com/jasanhdz/binance-futures-bot-ts/commit/e1bbd7da23a93f6ce73226b6446beb2d3527ab63).
Este cierre documental fija esa referencia sin cambiar source. Los resultados de
1.004 tests son los de las ejecuciones anteriores detalladas arriba, no una nueva
ejecucion durante el cierre. El usuario tambien comunico `tsc --noEmit` PASS.
Se comprobo nuevamente `git diff --check`; no se repitieron suites ya satisfactorias.
Se conserva expresamente la incidencia previa de journals sinteticos de la seccion 10.
La verificacion remota y este cierre no constituyen deployment ni validacion LIVE.

## 11. Cierre De Frescura, Procedencia Y Compatibilidad, 2026-09-12

Implementacion nueva: [b2d1fed5f39fc34de7bbb98629db18e67a55637b](https://github.com/jasanhdz/binance-futures-bot-ts/commit/b2d1fed5f39fc34de7bbb98629db18e67a55637b).
Base local y remoto real comprobados: `a466fffe6205c4ba2f3a4ef8f79db82f2b339674`.
Se leyeron AGENTS, este informe, el script original de cuatro reproducciones
`/tmp/opencode/micro-diagnostic-contracts.cjs`, sus regresiones versionadas y los
contratos de router, replay, admission y journal. Los cambios de e1bbd7d/a466fff
son antecedentes; los resultados siguientes corresponden a esta continuacion.

### Hallazgos Cerrados En Source

| Hallazgo                                       | Implementacion                                                                                                                                                | Regresion / resultado                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candle 1m fresca al as-of pero caducada al uso | `MicroBurstReactionEntryPolicy`, `MicroBurstInputFreshness.isMicroInputFresh`                                                                                 | Baseline LONG/SHORT: ENTRY_INTENT incorrecto tras 200 ms; corregido NO_TRADE / REACTION_CANDLE_UNAVAILABLE. Limites menor/igual/mayor, offsets locales +/-100 s, timestamps invalidos y candle futura excluida: PASS |
| Espera critica ACK                             | `EntryStrategy.validateAfterRequiredAudit`, `StrategyRouter`, `MicroBurstStrategy`                                                                            | ACK avanza 200 ms; MICRO_CANDLE_STALE, conserva replay de la evaluacion original ENTRY_INTENT y etiqueta postAuditAdmissionRejected: PASS                                                                            |
| Expiracion de inputs consumidos antes del send | Proof compacto `inputFreshness` trasladado por Evaluator -> Runtime -> TradingService -> ExecutionIntentFactory; `validateEntryMarket` exige proof en runtime | Candle/BTC/flow/book originales revalidados; un nuevo book no renueva los originales. PREPARED caduca candle: cero llamadas a send, cierre durable: PASS                                                             |
| PREPARED conocido como no enviado              | `DurableEntryCoordinator.execute/reconcile`                                                                                                                   | Outcome CANCELLED_BEFORE_SEND, transiciones existentes PREPARED -> CLOSE_PENDING -> CLOSED. Crash entre las dos ultimas: recupera sin lookup ni resend, identidad no reutilizable: PASS                              |
| Contaminacion de investigacion                 | `EvidenceEligibility`, Prospective/Paper/Generic Shadow analyzers y CLI generic                                                                               | Sinteticos explicitos/legacy excluidos; incompletos visibles con INSUFFICIENT_PROVENANCE; SHADOW UNOFFICIAL completo permitido; outcomes requieren union compatible: PASS                                            |
| Aislamiento y compatibilidad                   | `OfflineTestBootstrap`, fixtures Aegis/ExitEye/ML/logger                                                                                                      | Suite completa offline, un worker; 2867 PASS, dos checkpoints historicos FAIL, sin exclusiones nuevas                                                                                                                |
| Observabilidad accesible                       | `MicroBurstBlackBoxObservation.observationHealth`, `MicroBurstRuntime.reportHealth`, `DurableEntryCoordinator.getTimingHealth`, router ACK timing             | Capture attempts/failures, cola, memoria del proceso y tiempos acotados; writer bloqueado y contabilizacion incluyendo in-flight: PASS                                                                               |

**Temporalidad:** se mantiene `ctx.timestamp` como as-of original y se seleccionan
solo candles `closeTime <= ctx.timestamp`. La edad se mide contra
`exchangeObservedAtMs`, cota exchange ya construida con request/response y elapsed
monotonic. No se descarga otra candle para rescatar el trigger. El proof conserva
localDecisionAtMs/exchangeDecisionAtMs y close/event/receive originales. El guard
de envio traslada el reloj exchange con el elapsed local desde esa pareja; rechaza
retroceso local, finitud invalida, eventos futuros, as-of incompatible y expiracion.
La seleccion y los limites de politica tienen una autoridad compartida de edad.
El modo legacy del helper queda compatible; la apertura Micro de runtime exige proof.

La revision de evaluador pasa a `micro-reaction-at-use-freshness-2`. Un replay sin
exchangeObservedAtMs es incompleto; una revision anterior no se evalua como actual.
El replay reproduce la evaluacion, no la decision posterior de admission, fills ni
beneficios. El test ACK demuestra expresamente ENTRY_INTENT en replay original y
NO_TRADE posterior. Los 721 registros historicos no contienen inputs exactos y
siguen sin ser replay exacto. No se demostro una orden real obsoleta.

No se cambiaron stop independiente, TP opcional, salida inteligente, obstaculo mas
cercano, thresholds, costes, presupuesto, leverage, lookback, pivots ni confirmaciones.
La terminacion nueva certifica que el propietario aun no llamo send; no cancela una
orden del exchange. Crash sin evidencia terminal conserva el comportamiento fail-closed.

### Journals De La Incidencia, Lectura Y Elegibilidad

Se inspeccionaron las dos filas originales. No se movieron, borraron, reescribieron
ni versionaron. Hash inicial, repetido durante el trabajo y al cierre de source:

| Archivo bajo logs/micro-burst/shadow-signals | SHA-256 sin cambios                                              | Clasificacion                            |
| -------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| 2026-09-11-1789113398078.jsonl               | d79c735336340674f5bcbdcf8e0fe331ea558277ab5272eeeeebb4036ff12523 | SYNTHETIC / KNOWN_LEGACY_RUNTIME_FIXTURE |
| 2026-09-11-1789113398220.jsonl               | 2169289cf045fe6e951b4a9c42d81e5a3537332b069e961dad4c765415900850 | SYNTHETIC / KNOWN_LEGACY_RUNTIME_FIXTURE |

El reconocimiento legacy exige la combinacion schema=1, cohort UNOFFICIAL, ambos
hashes UNKNOWN, snapshot/observed=1000, liveExecution=false y el par exacto
id/version (`live-signal`/`0.8.0-expected-continuation-shadow` o
`runtime-golden`/`golden`). UNKNOWN aislado no se etiqueta como sintetico. Origin
TEST/SYNTHETIC explicito siempre excluye aunque el timestamp parezca real.

Comprobacion readonly adicional con el clasificador implementado:
`2026-09-11-1789164936957.jsonl`, una fila SUI del commit declarado 8c04b21,
hash `bdace3072cf7482e27665496069c7f453a75fee34dc72bbeb5695dc7d054186b`, es
MARKET_RESEARCH / LEGACY_COMPLETE_PROVENANCE pese a liveExecution=false. Es otra
ventana posterior, no una entrada de las 721 decisiones del diagnostico. Los tres
archivos devuelven MICRO_REPLAY_INCOMPLETE_OR_UNSUPPORTED: son journals compactos.
Script readonly usado: `/tmp/opencode/micro-followup-eligibility.cjs`.

La elegibilidad requiere version/schema, identidad, simbolo/lado, timestamp finito,
commit completo y config SHA-256 (con o sin prefijo sha256:). Es elegibilidad de
investigacion declarada, no autenticacion criptografica de mercado. No hay cutoff
de fecha arbitrario ni exclusion global de SHADOW/UNOFFICIAL. Los reportes mantienen
filas/IDs brutos, duplicados e incompletitud; publican elegibles/excluidos y razones.
Prospective excluye del rendimiento los outcomes huerfanos, con senal excluida o
proveniencia incompatible. Paper y generic etiquetan SHADOW_PROJECTION, nunca PnL
LIVE. Ni mode=LIVE ni accountVerified suministrados en una fila conceden esa autoridad.
Las metricas de cuenta siguen requiriendo su evidencia de ejecucion/settlement.

Consumidores revisados: `scripts/micro-burst-analyze-shadow.ts` -> Prospective;
`scripts/micro-burst-analyze-paper.ts` -> Paper; generic CLI -> core ShadowTradeAnalyzer.
No se encontro un consumidor Python de estos journals ni se creo pipeline ML.
Los loaders siguen leyendo los originales; esta correccion es de elegibilidad al
consumir. Inventario final directo: 451 archivos en shadow-signals. No se capturo
inventario inicial completo, por lo que no se presenta un delta de directorio como
prueba; los hashes de los dos archivos y las barreras del runner son evidencia separada.

### Validacion Ejecutada, Sin Sumar Ejecuciones Solapadas

Comando completo final (timeout de herramienta 600 s, prioridad reducida):

```sh
env -i PATH="$PATH" HOME=/tmp/opencode TMPDIR=/tmp/opencode \
  NODE_OPTIONS="--require=$PWD/src/testing/OfflineTestBootstrap.cjs" \
  nice -n 10 ./node_modules/.bin/vitest run \
  --config src/testing/OfflineVitest.config.ts --configLoader runner \
  --no-cache --reporter=dot --silent
```

| Ejecucion                                                             | Resultado                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Repro nueva antes de corregir                                         | 16 tests: 14 PASS, 2 FAIL esperados LONG/SHORT; 661 ms                                      |
| Primer bloque dirigido                                                | 94 PASS / 6 archivos; 15.64 s                                                               |
| Primer noEmit                                                         | FAIL: Array.at incompatible con lib del proyecto; sustituido por slice sin cambiar target   |
| Primera suite completa intentada                                      | Interrumpida por timeout de herramienta 120 s; sin conteo final, no contada como validacion |
| Primera suite completa terminada                                      | 2865 tests: 2839 PASS, 26 FAIL; 219 archivos, 326.79 s                                      |
| Reparacion dirigida de fixtures/aislamiento                           | 33 tests: 31 PASS, 2 FAIL logger; corregido mock default fs                                 |
| Journal durable y logger despues                                      | 46 PASS / 2 archivos; 14.68 s                                                               |
| Suite completa final, inicio 2026-09-12 03:25:40 UTC                  | **2869 tests: 2867 PASS, 2 FAIL; 218 archivos PASS, 1 FAIL, 219 total; 319.21 s**           |
| TypeScript --noEmit, Prettier de archivos cambiados, git diff --check | PASS                                                                                        |

Los dos FAIL finales son `original-operational-semantics.test.ts`:
`binds the exact owner-authorized current-brain contract exception` y
`tracks branch bytes separately from deployment authorization`. Ambos esperan
TradingService SHA-256 `8355482271127029f6854c470146045cfc3e9751fadede44afb26b7f81de5e28`;
source nuevo mide `7f96b5f54a52f25fa2ec24391682c14fec86ee3ccf78925457da259dd779356d`.
No se editaron hashes/checkpoints, aprobaciones, exclusiones ni estas expectativas.
La suite completa no se declara verde. Estos dos contratos requieren revision
de autorizacion futura, no una actualizacion automatica para permitir deploy.

La suite incluye Micro, Aegis, Momentum, router/blackbox, shared execution,
persistencia, market data, configuracion, stops y recovery. Fixtures Aegis ahora
habilitan solo CONFIG en memoria dentro de tests con puertos mock y restauracion;
axios es mock en MLAdapter. Ningun servicio Aegis real fue habilitado. El preload
anula dotenv/credenciales antes de imports, bloquea escrituras de workspace
(incluyendo promises.open, streams y SQLite nativo), y bloquea red salvo puertos
loopback efimeros creados por el mismo proceso de test. Esto permite el test de
diagnostico mock sin acceso a localhost:8010 ni exchange. El logger test usa fs mock
y verifica las dos escrituras locales mock, sin tocar logs operativos. El fixture
Runtime ya temporal en e1bbd7d se conservo. No hubo bootstrap main, bot, deploy,
restart, build a dist, peticion de cuenta, orden real ni escritura operativa.

Se aplico Prettier solo a los archivos modificados: `npm run format` expande a
`prettier --write .` y su alcance global contradiria la preservacion de journals.

### Procedimiento Futuro Para Una Ventana Autorizada

Este procedimiento queda documentado; no se ejecuto un deploy ni una ventana LIVE.

1. Fijar una ventana cerrada `[inicio, fin)` de **al menos 30 minutos**, posterior
   a una futura instalacion autorizada. Registrar proceso/PID/boot, commit declarado,
   config efectiva canonica y manifest/firma del artefacto aprobado. Comparar bytes
   del artefacto y source; no basta HEAD ni una variable approvedCommit. Resolver los
   checkpoints anteriores mediante su proceso de autorizacion antes de operar.
2. Leer prefijos acotados de `data/strategy-blackbox/strategy-decisions/decisions-v2.jsonl`,
   snapshots y `<decisions>.timing.jsonl`, mas logs `MICRO_BURST_SHADOW_HEALTH` y
   `micro_burst_entry_policy_selected`. Guardar limites de bytes/hashes en un directorio
   de auditoria separado. Mantener filas malformed/duplicadas/conflictivas visibles.
   El endpoint existente `/diagnostics/market-data` es salud generic compartida;
   no confundir sus contadores observacionales con la cola exacta Micro.
3. La cola exacta se obtiene sin REST adicional mediante `MicroBurstRuntime.getHealth().observationQueue`
   y el evento periodico/graceful_shutdown `MICRO_BURST_SHADOW_HEALTH.observationQueue`.
   Contiene captureAttempts/captureFailures, accepted/written/failed/dropped,
   pendingRecords/pendingBytes y peakRecords/peakBytes, incluyendo in-flight,
   lastQueueWaitMs/lastWriteDurationMs y drainTimedOut. Muestrear antes/despues dentro
   del mismo boot. Shutdown drops pueden incluir records previamente aceptados:
   no usar accepted+dropped como denominador universal.
4. Denominador de cobertura: todas las decisiones unicas observadas en la ventana,
   reconciliadas con totalEvaluations y captureAttempts; numerador: IDs escritos con
   replay completo y revision/commit compatibles. Informar pendientes, fallidas,
   descartadas, fallos de captura y diferencias. Si un drop perdio su ID, no inventar
   su simbolo, lado o rechazo ni inferir cobertura total desde written solamente.
5. Construir embudo disjunto por decisionId: guards comunes una vez, candidatos y
   primer rechazo por lado aparte, mejor etapa alcanzada, ENTRY_INTENT evaluado,
   rechazo post-ACK, admission y send. Unir signal/episode/trade/operation IDs sin
   sumar LONG+SHORT como decisiones. Publicar simbolo/lado y razones de exclusion de
   evidencia antes de hablar de resultados economicos. Las proyecciones SHADOW y
   outcomes no prueban fills; LIVE requiere ejecucion/settlement verificados.
6. Medir contextStartedAtMs/contextBuiltAtMs/contextDurationMs y candleReads desde
   `strategyInputReplay.context.inputSources.timing`; capture desde inputCaptureTiming;
   evaluacion desde diagnostics.evaluationTiming. Duraciones monotonic; timestamps
   locales explicitamente separados de as-of/event time exchange. Candle/BTC/flow
   age = exchangeDecisionAtMs menos evento original; book age = localDecisionAtMs
   menos receive original. Conservar cotas de clockReference. No restar medianas de
   series diferentes ni llamar CPU al elapsed total.
7. ACK: diagnostics.requiredAuditTiming con inicio/fin locales y durationMs monotonic,
   separado de evaluacion. PREPARED append+flush: `DurableEntryCoordinator.getTimingHealth()`
   disponible en `TradingService.getAegisRuntimeSnapshot().entryPreparationTiming`;
   count/total/max/ultimo inicio-fin-duracion, sin buffer creciente. Es agregado de
   preparaciones completadas; no da percentiles por simbolo ni duracion de fallos.
   Persistencia observacional completada: unir DECISION_PERSISTENCE_TIMING por ID;
   sink ACK no equivale a atestacion fsync. Nunca mutar el record ya encolado para
   insertar tiempos futuros. Usar los timestamps de cada tramo solo en su dominio.
8. Memoria: observationQueue.processMemory y memorySampleAtMs son RSS/heap/external/
   arrayBuffers del proceso muestreado. pendingBytes/peakBytes son estimacion
   conservadora de copia, no bytes JSON ni heap retenido medido. Los 84 drops del
   benchmark writer-bloqueado de seccion 10 siguen siendo sinteticos, no tasa LIVE.
   No derivar p95 de max/ultimo valor; calcular nearest-rank solo con muestras completas
   de cada metrica y declarar n/cobertura. E/T depth y receive aggTrade ausentes siguen
   null; no reemplazarlos por una consulta actual.
9. Ejecutar replay solo de registros completos en checkout limpio de su commit y
   revision correspondiente. Comparar evaluacion con evaluacion, admission con su
   prueba posterior; no afirmar que replay representa ejecucion o rentabilidad.
   Publicar diferencias e incompletos. Mantener separadas las ventanas historicas y
   futuras, sin promesa de mas entradas, menos latencia real o profit.

Pendiente exclusivamente operativo: autorizacion de artefacto/checkpoints y medicion
de una ventana futura con estos campos. Esta entrega implementa y prueba los cambios
offline; no certifica el proceso actualmente cargado ni sus resultados de mercado.
