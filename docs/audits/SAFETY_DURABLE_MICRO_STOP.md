# Reposicion Durable Del Stop Micro

Base: `858d17df7d2c8486b3d88c67946d057ed1f94815`, misma rama
`work/micro-burst-rider-v1-20260826`. Bloque vertical de reposicion, no protocolo
universal de stops ni autorizacion de despliegue.

## Ruta Conectada

`StrategyComposition -> TradingService -> PositionProtectionService ->
DurableStopCoordinator -> ExecutionJournal + BinanceExchange`.

- Produccion inyecta siempre el coordinador en LA MISMA instancia protectora que
  consume MicroEntryRecoveryService y la gestion normal. No hay fallback al envio
  legacy si falta una capacidad identificada. Constructores directos sin coordinador
  siguen siendo seams de tests de comportamiento anterior.
- Bootstrap abre el journal de stops antes del recovery de aperturas. Construir la
  factory no toca disco. Ruta unica por scope:
  `data/runtime/stop-mutations-binance-futures-bot-primary-{production|testnet}.jsonl`.
  Ancestros sincronizados y writer exclusivo, sin takeover de locks huerfanos.
- Scope obligatorio de proyecto single-account, no identidad descubierta de Binance.
  Cambiar cuenta/credenciales requiere intervencion operativa. No multihost fencing.
- Shutdown cierra admision, drena tareas runtime y luego ambos coordinadores, incluso
  si falla el cierre de aperturas. Stop espera su startup y transportes antes de
  flush/close; no libera el writer con un envio pendiente.
- Pendientes o fallo del coordinador bloquean el callback de admision de Shared;
  `stopMutationBlockedReason` los expone en el snapshot. El StateStore conserva
  `microProtectionBlocked` durante incertidumbre. No se cambia TP ni trailing Micro.

## Protocolo

- Una operacion de reposicion por parentTradeId y scope. Hash SHA-256 determinista;
  `operationId = stop:<digest>`, `mutationId = clientOrderId = bot_sl_<28 hex>`.
  Cambiar orderId, lado, simbolo, estrategia, cantidad o stop del mismo trade NO
  obtiene otro ID ni permiso de reenviar. Una reposicion adicional necesita un
  protocolo de recovery explicito futuro, no reset automatico.
- PREPARED persiste `STOP_MUTATION_V1`, scope account/environment, parentTradeId,
  parentOrderId, strategyId, symbol, side, positionSide, triggerPrice,
  positionQuantity, entryPrice, closePosition=true, workingType=MARK_PRICE e IDs.
  positionQuantity es la cobertura observada; no se envia quantity junto con
  closePosition. Timestamp, recvWindow y firma se generan en el transporte.
- Solo el caller que crea PREPARED durable puede enviar una vez. Comprueba identidad
  de la proyeccion despues de los awaits/flush y vuelve a leer posicion antes de
  enviar. PREPARED recuperado nunca se envia, aun sin ACK registrado.
- SUBMITTED significa receipt identificado; OPEN_CONFIRMED significa observacion
  exacta de la mutacion; PROTECTED registra cobertura observada; CLOSE_PENDING y
  CLOSED finalizan ESE resultado. Metadata declara STOP_MUTATION_NOT_TRADE y
  STOP_OBSERVED_NOT_POSITION_FLAT. **CLOSED no afirma posicion flat ni PnL**.
- Incluso CLOSED se consulta de nuevo antes de afirmar proteccion actual. Lookup
  desconocido, ausente, cancelado, disparado o con IDs incompatibles conserva bloqueo.
  No se usa el indice isSubmitted para decidir envios ni un CID fijo como fill.
- Al reiniciar, incluso las mutaciones CLOSED requieren nueva observacion antes de
  liberar admision. Si su parent trade ya termino y no existe proyeccion gestionable,
  el bloqueo se conserva: finalizar ese caso exige el protocolo de cierre/flat
  pendiente. No se descarta una reserva interpretando CLOSED como posicion cerrada.
- Reconciliacion identificada precede al latch legacy microStopSubmission. Un latch
  sin historia identificada impide preparar un nuevo envio; no se migra inventando ID.
- Un stop inicial ya existente puede observarse sin crear una mutacion: exige BOT,
  STOP_MARKET, precio actual exacto, side/positionSide y closePosition. Es observacion
  de proteccion legacy, NO prueba de receipt identificado ni journal del stop inicial.
- Se conserva schema 1, maquina de transiciones, validacion, locking, fsync y poison
  del storage 7d4c160. Unica adicion al puerto de storage: inventario **solo lectura**
  listOperations, para validar protocolo/scope tambien en operaciones CLOSED. No
  acepta formatos antiguos ni cambia ninguna transicion. Metadata de request debe
  conservarse igual en todos los eventos al reabrir.

## Transporte Y Evidencia

- El SDK instalado expone futuresOrder y futuresGetOrder pero no clientAlgoId ni
  endpoint algo tipado. Se usa el transporte raw existente, no se supone que
  newClientOrderId identifica una orden condicional algo.
- Envio unico POST `/fapi/v1/algoOrder`, algoType=CONDITIONAL, type=STOP_MARKET,
  clientAlgoId estable. Sin deteccion dinamica de hedge ni fallback por -4061/-4120.
  positionSide procede de la posicion observada y queda persistido antes del envio.
- GET del mismo endpoint por clientAlgoId. Receipt exige symbol/clientAlgoId/algoId.
  Lookup exige ademas algoStatus=NEW, algoType, orderType=STOP_MARKET, lado,
  positionSide, triggerPrice exacto, workingType y closePosition. IDs numericos no
  representables exactamente en JavaScript se rechazan. Despues se vuelve a leer
  posicion y se exige cantidad/entrada exactas y misma identidad local.
- Se intentaron las paginas oficiales New-Algo-Order y Query-Algo-Order con webfetch
  y Query-Algo-Order con curl publico: no devolvieron contenido util. Por tanto no
  se afirma verificacion documental oficial satisfactoria ni compatibilidad operativa
  certificada. El contrato raw implementado y probado con mocks falla cerrado ante
  una respuesta distinta. No se hizo ninguna consulta autenticada ni orden real.
- Las lecturas no son un snapshot atomico de Binance. Cambios externos posteriores,
  historia de fills/ownership universal y la verificacion operativa quedan pendientes.

## Validacion

Validacion propia final: `npm run test:safety` PASS, build y 2.274 pruebas principales
en 188 archivos + 46 ConfigLoader en 1 archivo = **2.320 tests, cero fallos**.
Se corrigio una regresion real en la comparacion del latch legacy: el latch guardado
por el propio servicio no debe invalidar su identidad. Se conservaron las assertions.
Una corrida intermedia fallo por SQLITE_BUSY y un error I/O posterior del fixture
de rate limiter multiproceso; la siguiente corrida global paso sin modificar ese
modulo. La intermitencia SQLite conocida no queda resuelta por este bloque.
Los **2.288 tests** de SAFETY_MICRO_ENTRY_RECOVERY son el resultado historico de la
base, no se presentan como una ejecucion de este bloque.

Cobertura nueva: filesystem real/restart, ACK perdido/no resend, PREPARED sin envio,
fsync fallido, cambio de identidad durante persistencia y despues del restart,
lookup exacto, stop desaparecido, scope conflict incluido CLOSED, close con envio
pendiente, factory perezosa/writer unico, recovery Micro con el mismo protector y
arranque real con entrada OFF. Transporte usa respuestas derivadas del CID enviado,
no un fill sintetico como evidencia. Tests de campos incompatibles y errores
codificados no autorizan retry.

## Pendiente Exacto

### Resolucion observacional posterior a 7035640

TradingService ejecuta `reconcileClosed` al arrancar y periodicamente. No envia ni
cancela ordenes: solo resuelve una reserva de stop cuando el MISMO trade/orden/lado/
estrategia tiene cierre operativo IDLE persistido y fecha valida, el lookup exacto
del stop devuelve CANCELED, hay dos lecturas frescas flat y una final tras listar
ordenes sin BOT supervivientes. Una orden ausente, NEW, disparada o estado desconocido
no basta. Se preservan flags contables y ordenes ajenas.

La evidencia queda en otra operacion del mismo archivo: `STOP_RETIREMENT_V1`, con
PREPARED -> CLOSE_PENDING -> CLOSED. No se modifica ni reabre la mutacion original.
El restart valida enlace, scope, identidad, orden, fechas y protocolo antes de excluir
esa reserva historica. Una interrupcion parcial reobserva exchange antes de finalizar.
Error de disco o cambio de identidad mantiene el bloqueo; shutdown drena estas tareas.

El listado standard/algo reconoce tanto se_ legacy como bot_sl_ de formato exacto,
y conserva side para comprobaciones de cobertura. readFreshActivePosition evita
el cache de cuenta y rechaza snapshots incompletos/invalidos en vez de devolver flat.

Validacion propia: npm run test:safety PASS, build y 2.309 + 46 = 2.355 tests,
189 archivos entre grupos. Incluye 30 tests del coordinador de stops, 72 del adapter
y prueba del arranque real con journal en filesystem. Una corrida previa tuvo el
SQLITE_BUSY conocido y error I/O posterior en rate limiter; la siguiente corrida
global paso sin cambios en ese modulo. No se afirma resuelta esa intermitencia.

Limites: CANCELED significa cancelacion verificada, no stop ejecutado; TRIGGERED /
FINISHED y fills de cierre siguen pendientes. La observacion no es una transaccion
atomica con Binance ni contabilidad verificada. El protocolo de envio/cancelacion/
cierre universal y la liberacion monetaria siguen separados de esta resolucion.

| Area                                            | Estado                                                        |
| ----------------------------------------------- | ------------------------------------------------------------- |
| Reposicion Micro normal y recuperada            | Conectada al coordinador identificado; una mutacion por trade |
| Stop inicial de Shared                          | Pendiente de usar este protocolo; conserva ruta previa        |
| Brackets Aegis/Momentum y movimientos de stop   | Pendientes de journal identificado                            |
| TP, cancelaciones, close inteligente/emergencia | Pendientes de protocolo durable universal                     |
| Exposicion y reservas monetarias                | Pendientes de inventario y ledger runtime durable             |
| Fills, costes, PnL recuperado                   | Cuarentena conservada; contabilidad pendiente                 |
| Fase 9                                          | Extraccion/integracion parcial; no completada por este bloque |
| LIVE/testnet operativo                          | No ejecutado, no autorizado por tests o hashes                |
