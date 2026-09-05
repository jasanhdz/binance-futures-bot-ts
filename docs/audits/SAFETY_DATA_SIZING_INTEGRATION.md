# Safety: integracion de datos y sizing

## Alcance

- Rama unica: `work/micro-burst-rider-v1-20260826`.
- Base PUBLICADA verificada por fetch: `7d4c1605f2559c51b3f4d4e4f79002191734588a`.
- Continuacion de los cinco archivos parciales encontrados al iniciar. Se revisaron
  personalmente sus diffs y los consumidores actuales; no se revirtio trabajo previo.
- Este bloque es publicable, no completa safety ni fase 9. No integra el journal al
  protocolo de mutaciones, recovery, reservas de exposicion o contabilidad universal.
- PUBLICACION de este incremento: pendiente de verificar el push. Se registrara el
  SHA remoto del codigo en el seguimiento documental, sin inventar un hash autocircular.
- DESPLIEGUE: NO_AUTORIZADO. VALIDACION_REAL: PENDIENTE_DATOS/PENDIENTE_OPERADOR.

## Flujos integrados

| Flujo | Contrato consumido, no solo metadata |
| --- | --- |
| Micro/Aegis/Momentum -> SharedStrategyExecutionService | La cantidad inicial y retries por rechazo definitivo usan calculateMarginBudgetSizing; solo un resultado valido llega a marketOpen |
| Sizing legacy por perdida | calculateSizing conserva balance * riskFraction como lossBudget explicito y comparte floor/caps con el modo de margen |
| Proveedor de velas -> MicroBurstContextBuilder -> EntryPolicy | prepareClosedCandles valida OHLCV, timestamps y cadencia ORIGINAL antes de separar una unica cola en formacion; series invalidas no alimentan indicadores y contextValid impide entrada |
| Benchmark -> BtcMicroContextProvider -> contexto Micro | Valida antes de retornos, no ordena/deduplica; reemplaza por snapshot validado, invalida refrescos corruptos y distingue edad del evento de edad de recepcion |
| Cache Aegis -> TradingService -> AegisEntryContextBuilder | Valida antes de filtrar/indicadores; propaga candleDataQualityReasons por un Pick tipado, no Record arbitrario; sin REST adicional |
| Contexto Aegis -> RegimeContextGuardAdapter | Valida velas cerradas y frescura antes de calcular; respeta ventanas EMA/ATR Wilder/volumen/Bollinger/ADX/choppiness y warmup |
| Snapshot legacy -> RegimeGuardAdapter -> admision | Edad ausente/no finita/negativa produce UNKNOWN, no se corrige futuro a edad cero; RegimeAuthority determina el rol usado para enforcement |
| Contexto -> LongRisk / SafetyConsensus | LongRisk consume EMA25 fija, no emaMid configurable; SafetyConsensus rechaza evidencia invalidada o label UNKNOWN sin cambiar sus modos ni familias |

## Semantica y efectos

- `positionFraction = 0.9` sigue siendo asignacion de MARGEN sobre capital disponible
  con el haircut existente. NO es 90% de perdida tolerada. No se eligio presupuesto
  de perdida LIVE ni se activo el lossBudget opcional en Shared.
- Cantidad en unidades enteras de precision, floor por step, sin toFixed que redondee
  hacia arriba. Filtros incompatibles o caps presentes invalidos se rechazan, no se
  ignoran ni se sustituyen por precision sintetica. Caps de margen/notional/perdida
  se comprueban estrictamente despues del floor, sin tolerancia que permita excederlos.
- Diferencia probada del retry: `0.114 -> 0.102 -> 0.091`, en lugar del antiguo
  `0.114 -> 0.101 -> 0.090`. Se elimina el step adicional perdido por doble floor
  flotante; cada retry sigue bajo 90% del anterior y sus caps. No es paridad bit a bit.
- `minQty/maxQty` son caps del motor puro cuando se suministran; el puerto Exchange
  actual no los expone. No se afirma validacion de filtros que el adaptador no entrega.
- Cierre inclusivo: `closeTime <= snapshot`. Solo se separa una cola cuya apertura
  ya ocurrio. Historial futuro multiple, gaps, duplicados, volumen negativo o timestamps
  ausentes invalidan el contexto; replay debe suministrar un prefijo causal explicito.
- Micro mantiene sus limites de frescura configurados. Aegis exige ultima vela cerrada
  dentro de un intervalo del timeframe; es una nueva restriccion de integridad, no
  calibracion de estrategia. Historial de EMA99 puede superar 24h sin ser rechazado
  por una edad global artificial. No se modificaron thresholds ni archivos de config LIVE.
- BTC Micro ya no renueva una serie vieja solo por recibirla otra vez. El builder
  comprueba tambien edad de evento contra snapshot y retornos finitos; recepcion
  HEALTHY no implica contexto valido. Cambia el tratamiento inseguro de datos viejos.
- EMA fast/mid/slow tienen semilla SMA y recurrencia EMA sobre toda la historia
  validada; slope es cambio relativo de EMA de una barra, no retorno del cierre.
  EMA25 es independiente de la ventana mid. ATR conserva suavizado Wilder.
- `atrPercentile` conserva la metrica auxiliar previa del seam (percentil de TR
  relativo), no se presenta como una nueva distribucion calibrada de ATR. Se rechaza
  si es no finita o fuera de [0,1]. Confidence sigue siendo heuristica, no probabilidad.
- `regime_context` no veta por si mismo aunque figure ENFORCE; `enforced` conserva
  su campo legacy de modo y metadata declara rol INFORMATIONAL. El guard legacy es
  la unica autoridad de REGIMEN, no la unica regla de riesgo de la aplicacion.
- La correccion UNKNOWN conserva `blockWhen`: OFF no veta; SHADOW observa; ENFORCE
  bloquea UNKNOWN solo si la politica existente lo incluye. No se anadio una regla LIVE.
- No se afirma que corregir indicadores sea neutral: EMA25 ahora puede aumentar el
  score LongRisk y afectar su enforcement indirecto de Probe/consenso. SafetyConsensus
  conserva requireValidRegimeForCriticalLong: datos invalidos NO activan ese veto
  estrecho; el consenso de familias sigue aplicando su modo. Tests cubren esa diferencia.
- Golden Micro (17) y MarketContextParity (21) pasan como regresiones de sus fixtures;
  no prueban paridad economica universal ni ausencia de cambios de seleccion.
- No se cambio salida inteligente Micro, trailing, TP, manifiestos ni aprobaciones.
  Los tres digests de fuente actualizados en restoration corresponden a TradingService,
  tipos de contexto y AegisRegimeGuard; no son autorizaciones LIVE.

## Evidencia propia

- `npm run build`: PASS.
- `npm run test:safety`: ultima ejecucion completa PASS, 182 archivos / 2.160 tests
  principales + 1 archivo / 46 tests ConfigLoader = 183 archivos / 2.206 tests.
- Se ejecutaron fixtures de Shared (39), TradingService simulado (122), CandleIntegrity
  (29), sizing (31), Micro builder (12), BTC Micro (23), context adapter (24), y suites
  indirectas/arquitectura. Journal: 264 tests de regresion, sin nueva integracion.
- Hubo fallos intermedios reales: tipado del modo especial y timestamp obligatorio
  del fixture BTC, diferencia de retry y edades invalidas aceptadas por legacy. Se
  corrigieron codigo/fixtures segun contrato sin skips ni relajar assertions.
- Una corrida intermedia fallo ademas por SQLITE_BUSY al inicializar WAL en el test
  multiproceso de `shared-binance-rate-limit`. Sin cambios en ese modulo: paso despues
  en seleccion dirigida y regresion completa. Riesgo intermitente pendiente, NO resuelto.
- Formato de TypeScript modificado y `git diff --check` revisados antes de publicar.
- No bot, main.ts, PM2, testnet operativo, exchange real, replay economico ni soak.
  No lectura manual de .env/secretos/valores LIVE; el runner existente usa su separacion
  de ConfigLoader y mocks. No se modificaron esos archivos de configuracion.

## Pendientes

| Fase | Estado despues del bloque | Pendiente |
| --- | --- | --- |
| 1/2/3/4 | PARCIAL | Journal mutations/IDs/receipts, recovery antes de admision, exposure global/reservas durables, fills/costes/ledger y shutdown con incertidumbre |
| 5 | PARCIAL | Validacion de proveedores restantes y contratos temporales universales; este bloque valida lo recibido por los consumidores indicados |
| 6 | PARCIAL/PENDIENTE segun checklist | Hash efectivo/aprobacion y manifiestos; sin autoaprobar |
| 7 | PARCIAL | Comparacion legacy/V2 y evidencia; no se migro autoridad a V2 |
| 8 | PARCIAL | Presupuesto autorizado de perdida, quote/fill fresco, geometria y reservas de cuenta |
| 9 | PARCIAL | Extraccion completa de admision, supervision, reconciliacion y apagado; no basta el seam tipado |
| 10 | PENDIENTE de completar | Tooling y evidencia economica real; tests sinteticos no certifican rentabilidad |
