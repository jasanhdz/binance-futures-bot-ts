# Recuperacion Micro desde apertura durable

## Base y alcance

Base publicada: `5cdddf63a942b4280069d063cd048131f2276527`, rama unica
`work/micro-burst-rider-v1-20260826`. Este bloque incorpora los cambios locales de
lookup reforzado que quedaron pendientes y agrega recuperacion Micro conectada.
No cierra las fases 1/2/3/4/9 ni activa despliegue.

## Flujo real

`TradingService -> DurableEntryCoordinator.reconcile -> MicroEntryRecoveryService
-> readRecoverableEntryPosition -> StateStore/flush -> PositionProtectionService`.

- El handler se registra antes de start. Solo se invoca desde reconciliacion, no
  mientras Shared procesa el recibo de una apertura en vivo.
- Reutiliza LA MISMA instancia protectora y su exclusion por simbolo. No instancia
  otro supervisor de stops. Las tareas de recovery se registran para shutdown.
- Reconstruye un store verdaderamente vacio (IDLE sin otro campo definido). Nunca
  sustituye estado de otro trade, externo, ni una identidad local de cierre anterior.
- Usa trade/order/client ID, lado, version/hashes de estrategia, cantidad, leverage,
  stop estructural y destino del intent original. No toma parametros de entrada nuevos.
- Guarda y hace flush antes de proteger; comprueba identidad tras esperas y persistencia.
  Estado reconstruido lleva `recoveredEntryMutationId`, fecha de fill y origen BOT.
- No fabrica aperturas en el contador de sesion, PnL, comisiones ni historia economica.
  Conserva `microBurstPnlUnverified`, exclusion de metricas y reserva del coordinador.
  El handoff NO finaliza por confirmar un stop mientras esa contabilidad siga pendiente.
- El loop incluye simbolos recuperados abiertos aunque salieran del universo configurado.
  El modo de entrada OFF no bloquea la proteccion. La salida inteligente sigue en el
  manager Micro existente, sin trailing ni TP obligatorio.
- FsStateStore reutiliza la instancia hija por simbolo: composicion/handoff y gestion
  ya no observan caches independientes para el mismo archivo dentro del mismo root.

## Atribucion conservadora

`readMarketOpenByClientOrderId` admite expectativa de lado, cantidad y tiempo. Recovery
de produccion exige orden MARKET FILLED, cantidad original/ejecutada exacta, lado y
positionSide compatibles, tiempo no anterior al intent y precio positivo.

Para reconstruir ownership se exige ademas `readRecoverableEntryPosition`:

1. Lookup exacto por client ID; la orden no debe ser reduceOnly/closePosition.
2. Dos lecturas no cacheadas de positionRisk, rodeando la consulta de fills.
3. Una sola posicion compatible, cantidad/entrada/leverage validos y updateTime no
   posterior a la ejecucion de la orden. La segunda lectura debe conservar identidad
   de actualizacion y leverage.
4. Fills consultados SIN filtro de orderId desde la creacion de la orden: cualquier
   otro fill del simbolo, cierre/reapertura, duplicado o cantidad incompleta impide
   atribuir. Suma decimal exacta a 18 decimales, sin tolerancia que acepte fills faltantes.
5. Ventana maxima de 7 dias y menos de 1000 fills. Pagina llena o historia fuera de
   ventana se rechaza conservadoramente, sin fingir que se pagino todo el historial.

Es evidencia acotada, NO snapshot transaccional del exchange. Movimientos externos
concurrentes despues de las lecturas requieren supervision posterior. Las igualdades
estrictas de cantidad/precio/updateTime pueden rechazar casos legitimos; el resultado
es PENDING, no adopcion especulativa. Aegis/Momentum, ajustes parciales, estado previo
no vacio e historias largas siguen requiriendo recovery posterior explicito.

Se inspecciono el SDK instalado: futuresGetOrder -> /fapi/v1/order y futuresUserTrades
-> /fapi/v1/userTrades; tipos QueryFuturesOrderResult, PositionRiskResult y
FuturesUserTradeResult. Se intentaron paginas oficiales Query-Order y Account-Trade-List
con webfetch, sin contenido util. No se afirma verificacion operativa de la API.

## Stop y concurrencia

Continuacion desde 858d17d: ver [reposicion durable Micro](SAFETY_DURABLE_MICRO_STOP.md).
Esa ruta ahora inyecta STOP_MUTATION_V1 en el mismo protector antes del latch legacy;
la descripcion y los conteos siguientes documentan la base historica, no la suite nueva.

PositionProtectionService persiste su latch microStopSubmission antes del envio,
revalida identidad/intent despues del flush y no repite un intento incierto tras
reinicio. Para recovered entries exige cobertura BOT con side/positionSide explicitos.
Un cambio de cantidad/entrada respecto a la proyeccion recuperada produce UNKNOWN.

El adapter de stops ya no cambia de endpoint por timeout/prosa/error generico. El
fallback de modo exige -4061 y el fallback a algo exige -4120 numerico. La identidad
universal de stops/TP/cierres/cancelaciones en el journal sigue PENDIENTE; el latch
del stop no se presenta como protocolo universal. No se modifico el fallback de TP.

## Validacion propia

`npm run test:safety`: build PASS, grupo principal 186 archivos y 2.242 tests;
ConfigLoader separado 1 archivo y 46 tests. Total **2.288 tests, cero fallos**.

- Diez casos de MicroEntryRecoveryService con filesystem/StateStore/journal reales,
  exchange simulado y el protector usado por runtime: recovery, restart, ACK perdido,
  conflictos antes/durante persistencia, cantidad/order equivocados y stop no duplicado.
- Test del arranque real de TradingService con entrada OFF, estado vacio, apertura
  pendiente y stop observado: no llama marketOpen ni placeTpClose.
- Ocho regresiones de lookup reforzado, seis de atribucion de fills/posicion y tres
  de no reenviar stops por errores no codificados. Regresion existente preservada.
- Se corrigieron errores de tipado de fixtures/flush y checkpoints de fuente antes
  de la validacion final. Digests son checkpoints de codigo, no aprobaciones LIVE.
- No bot, main.ts, PM2, testnet operativo, orden real, secretos ni config LIVE.

## Pendientes y publicacion

| Area                        | Implementado/integrado                                   | Pendiente                                                   |
| --------------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| Recovery Micro vacio        | SI, journal -> proyeccion durable -> protector existente | Casos no atribuibles y otras estrategias                    |
| Proteccion Micro recuperada | SI, latch previo y confirmacion exchange                 | IDs de mutacion de stop/receipt/lookup universales          |
| Contabilidad                | Cuarentena conservada                                    | Reconstruccion de contadores, fills/costes y ledger runtime |
| Exposicion/reservas         | Bloqueo de cuenta retenido                               | Inventario global y reservas monetarias durables            |
| Fase 9                      | Servicio de recovery separado y consumidor real          | Extracciones/integraciones restantes                        |

Cambios de este documento describen el bloque local listo para publicacion. El SHA
publicado se verifica despues del commit/push; no usar la suite para autorizar LIVE.
