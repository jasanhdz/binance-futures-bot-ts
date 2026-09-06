# Safety: primer corte durable de apertura

## Alcance

- Base: `73856b8`, rama `work/micro-burst-rider-v1-20260826`.
- PUBLICACION: codigo publicado en `d249794bd9ba80c7c940c0796c10984af19236fb`,
  comprobado con `git ls-remote` despues del push normal. Este registro posterior
  solo documenta esa comprobacion, no una ejecucion adicional de tests.
- IMPLEMENTACION: primer corte de apertura conectado; fases 1/2/3/9 PARCIALES.
- No sustituye `StrategyRiskSessionService` ni `PositionProtectionService`.
- No cambia main, runtimeBot, PM2, configuracion LIVE, thresholds, secretos,
  salida inteligente Micro, trailing ni obligatoriedad de TP.
- VALIDACION_REAL: PENDIENTE_OPERADOR/PENDIENTE_DATOS. DESPLIEGUE: NO_AUTORIZADO.

## Contrato Consumido

`StrategyComposition -> TradingService -> SharedStrategyExecutionService ->
DurableEntryCoordinator -> ExecutionJournal + BinanceExchange.marketOpen`.

- La composicion de produccion siempre inyecta el coordinador. No es un opt-in de
  configuracion. Los constructores directos sin coordinador se conservan exclusivamente
  como seams de tests unitarios existentes; no crean un journal de disco por defecto.
- `DurableEntryRequest` contiene scope, OPEN, parentTradeId, intent completo JSON,
  quantity y clientOrderId. Se captura una copia antes de esperar; se revalida el
  intent y el callback de admision tras persistir, inmediatamente antes de enviar.
- `operationId = hash(scope, tradeId, clientOrderId)` identifica una MUTACION de
  apertura, no el trade. `mutationId = clientOrderId` es una identidad distinta.
  Cada retry de sizing usa otro clientOrderId y otra operacion bajo el mismo trade.
- Metadata declara `protocol: ENTRY_MUTATION_V1` dentro del request y
  `journalOperationMeaning: ENTRY_MUTATION_NOT_TRADE`. El archivo es exclusivo de
  este protocolo. No debe mezclarse con un journal de ciclos de posiciones.
- No se modifica schema 1, validacion, copias, transiciones, fsync, locking o politica
  de no takeover del almacenamiento publicado en `7d4c160`.
- Se reutilizan sus transiciones con el significado explicitamente autorizado para
  este archivo: PREPARED antes de enviar; SUBMITTED registra ACK; OPEN_CONFIRMED
  registra confirmacion de la mutacion; CLOSE_PENDING y CLOSED finalizan SU resultado.
  **CLOSED aqui NO afirma posicion cerrada, protegida, fills completos ni PnL.**
- Un rechazo codificado recorre PREPARED -> CLOSE_PENDING -> CLOSED con
  `ENTRY_MUTATION_REJECTED` y codigo durable. Nunca inventa OPEN_CONFIRMED.
- REJECTED se devuelve despues del CLOSED durable. CONFIRMED requiere evidencia
  OPEN_CONFIRMED durable; permanece pendiente hasta completar handoff de posicion.
  Shared expone `entryMutations` con operationId/mutationId/status en metadata.
- Errores sin codigo empresarial numerico inequivoco, ACK ausente/invalido,
  timeout y -2013 de lookup conservan UNKNOWN. No se reenvia PREPARED recuperado.
  Un fallo de persistencia conserva reserva y bloquea la instancia hasta reapertura.
- La reserva es exclusion conservadora de aperturas de toda la cuenta mientras hay
  una mutacion pendiente, no un ledger monetario ni una reserva de margen calculada.

## Bootstrap Y Recovery

- `composeDurableEntryCoordinator` construye sin tocar disco. `start()` crea el
  directorio en la factory de produccion, sincroniza ancestros y abre el journal
  bajo su lock exclusivo antes de leer pendientes.
- Ruta determinista: `data/runtime/entry-mutations-binance-futures-bot-primary-{production|testnet}.jsonl`.
  Scope de cuenta constante para el proyecto single-account; entorno derivado de
  `CONFIG.IS_TESTNET`, sin persistir claves, hashes de secretos ni configuracion privada.
- Esta identidad NO descubre la cuenta Binance. Cambiar credenciales/cuenta en el
  mismo proyecto requiere intervencion operativa; no hay soporte multi-account ni
  fencing entre checkouts/hosts. Procesos cooperativos deben compartir esta ruta.
- TradingService con esta dependencia nace con admision cerrada. `start()` espera
  recovery antes del resto del arranque; el gate de Shared impide abrir si quedan
  pendientes aunque la gestion de posiciones existentes continue.
- Recovery consulta IDs exactos o completa resultados ya durables interrumpidos
  entre transiciones. Ausencia/error no prueba rechazo. Nunca llama a marketOpen.
- El watchdog existente llama periodicamente a reconcile (cadencia existente de
  10 s, sin nuevo threshold); no se solapa con envios vivos ni con otro reconcile.
- `getAegisRuntimeSnapshot().entryMutationBlockedReason` y las razones de Shared
  hacen observable el bloqueo. Resolver una mutacion no borra automaticamente las
  cuarentenas legacy de estado o contabilidad. Una apertura confirmada NO libera
  la reserva hasta que el StateStore contenga tradeId, orderId, lado, estrategia,
  modo abierto y bracketsAttached, se haga flush y se revaliden esos campos.
- Shutdown cierra admision, detiene productores, espera tareas runtime, drena todos
  los stores/sinks y despues cierra el coordinador. Este espera envios y recovery
  propios antes de flush/close; errores de productores/flush no se silencian.
- El timeout exterior existente de 15 s y los locks huerfanos no se modifican. No
  hay reparacion automatica de archivo/lock, ni garantia frente a kill antes del drain.

## Transporte Verificado

- SDK instalado: `binance-api-node/dist/http-client.js`, `futuresOrder` invoca
  `_order(..., '/fapi/v1/order')`; `_order` realiza un unico `privCall(..., 'POST')`.
  `futuresGetOrder` consulta `/fapi/v1/order` con `origClientOrderId`.
  Se inspeccionaron tambien `privCall`/fetch y `BinanceExchange.enqueue`: sin retry
  interno de la orden. No se invoco la API para esta verificacion.
- Se intentaron las paginas oficiales New-Order/Query-Order via webfetch; la
  herramienta no devolvio contenido util. La evidencia utilizada es el SDK local,
  no una supuesta lectura satisfactoria de las paginas web.
- `marketOpen` ya no hace un segundo envio de fallback ante mismatch de modo.
  Comprueba identidad de ACK (symbol/clientOrderId/orderId). Lookup exige identidad
  exacta, tipo MARKET y un estado aceptado; el coordinador requiere precio positivo.
- La persistencia contiene los argumentos completos del puerto de apertura, NO el
  payload firmado ni timestamp/signature. La deteccion de hedge mode sigue dentro
  del adaptador; persistir positionSide/payload wire es trabajo del puerto universal.
- Se elimina el retry de sizing por texto. Solo los codigos numericos -2019, -2027
  y -4005 permiten otro intento, despues del rechazo durable en produccion. Los
  codigos empresariales restantes aceptados no generan retry. Codigos contradictorios
  entre envelopes quedan UNKNOWN. Esta es una correccion de seguridad, no paridad
  con el comportamiento anterior de retries por prosa o fallback de modo.

## Matriz De Cobertura

| Ruta | Persist-before-send | Resultado durable | Recovery sin reenvio |
| --- | --- | --- | --- |
| Micro -> Shared -> marketOpen inicial | SI | SI, por mutacion | SI |
| Aegis -> Shared -> marketOpen inicial | SI | SI, por mutacion | SI |
| Momentum -> Shared -> marketOpen inicial | SI | SI, por mutacion | SI |
| Retry de sizing de esas rutas | SI, otra identidad tras rechazo durable | SI | SI |
| Stop inicial Micro / brackets iniciales Aegis-Momentum | NO en este journal | NO en este journal | Proteccion existente, no nuevo protocolo |
| Stops de reposicion / movimiento / TP | NO en este journal | NO en este journal | Garantias existentes, no cobertura universal |
| Cierre inteligente / emergencia / cancelaciones | NO en este journal | NO en este journal | Garantias existentes, no cobertura universal |
| Leverage / margin type | NO en este journal | NO en este journal | Fuera de este corte |

Confirmar una apertura en recovery no restaura por si solo su estado de estrategia
ni coloca brackets. Si falta ese handoff, el journal permanece OPEN_CONFIRMED y
admission bloqueada, tambien tras restart. No se descarta exposicion por el ACK.
El supervisor existente no equivale a un recovery universal del trade. No afirmar
que este primer corte completa la seguridad de una posicion recuperada o permite
desplegar. Falta vincular reservas/handoff/proteccion/accounting de todo el trade.

## Validacion Propia

- Validacion propia del coordinador: `npm run test:safety` PASS. Build, 184 archivos
  y 2.194 tests principales + 1 archivo y 46 ConfigLoader = 2.240 tests, cero fallos.
  Incluye 27 tests de DurableEntryCoordinator, 1 de composicion y 264 del journal.
- La regresion adicional de handoff mantiene OPEN_CONFIRMED y bloqueo tras restart
  mientras falta evidencia durable de transferencia; el ACK por si solo no libera.
- Fixtures reales de Shared + coordinador + filesystem temporal: apertura y stop
  Micro sin TP, gate cerrado/denegacion sin envios, timeout despues de recepcion,
  lookup exacto, reinicio PREPARED/UNKNOWN, fallos en cada append posterior al ACK,
  fallo real de fsync, reintento tras rechazo codificado, ausencia de ACK, cambio de
  identidad, competidores y apagado con envio pendiente.
- Fixtures explicitos de memoria para lifecycle de TradingService. Factory real en
  directorio temporal para creacion perezosa, scope por entorno, writer unico y lock
  huerfano conservado. No se crea un journal operativo mediante los tests.
- Digests de fuente de TradingService/BinanceAdapter en restoration se actualizaron
  por estos cambios de safety y formato, no como autorizacion LIVE/modelo.
- SQLiteBusy de la suite multiproceso sigue como riesgo intermitente conocido; no
  se deshabilita ni modifica su test.

## Pendiente Exacto

### Verificacion exchange del handoff posterior a fc4f483

La composicion consulta posicion y ordenes antes de aceptar el handoff persistido.
bracketsAttached por si solo no libera admision: requiere cobertura BOT del lado y
positionSide observado, cierre de posicion completa o reduceOnly con cantidad suficiente.
TP solo se exige cuando el intent lo requiere; Micro con stop sin TP puede completar
handoff. Fallos de lectura, cobertura parcial o cambio de identidad mantienen pendiente.
Esto verifica proteccion al transferir, no garantiza su existencia futura ni reconstruye
posiciones sin estado local. Esas responsabilidades y el journal de stops siguen pendientes.

Validacion propia: npm run test:safety PASS, build y 2.211 + 46 = 2.257 tests
(186 archivos). Ocho regresiones nuevas del callback de composicion real, journal en
filesystem temporal y exchange simulado; sin ordenes reales ni cambios LIVE.

1. Puerto identificado universal OPEN/STOP/TP/CLOSE/CANCEL y payload completo wire.
2. Journal/handoff de proteccion y cierre; adopcion durable de un trade recuperado.
3. Reservas de margen/riesgo, inventario universal y fencing/identidad de cuenta real.
4. Reconciliacion de fills/costes/PnL y ledger runtime idempotente.
5. Consolidacion de fase 9 y resto de pendientes del traspaso, sin aprobar LIVE.

## Extraccion de apagado posterior a d249794

- TradingService delega el orden de cierre a `src/app/runtime/RuntimeShutdown.ts`
  mediante puertos tipados: cerrar admision, detener productores, consultar tareas,
  obtener flushes/drains y cerrar coordinador de mutaciones. No duplica esa secuencia.
- Se conserva registro sincrono de tareas y lock antes del primer await. La nueva
  extraccion publica la Promise antes de callbacks para soportar stop reentrante.
- Un stop completado o fallido es estable e idempotente: no ejecuta otro cierre sobre
  un journal ya cerrado. Una nueva sesion requiere nueva instancia del runtime.
- Fallos sincronos/asincornos de productores o flushes se acumulan sin abandonar
  otros recursos. El cierre de mutaciones se intenta al final; los errores se exponen
  mediante RuntimeShutdownError.failures, no se convierten en exito.
- Un timeout externo no libera recursos ni convierte tareas pendientes en terminadas.
  Las tareas admitidas pueden registrar trabajo hijo, que tambien se drena.
- Validacion propia: `npm run test:safety` PASS, build y 2.203 tests principales
  (185 archivos) + 46 ConfigLoader (1 archivo) = 2.249 tests, cero fallos.
  Nueve tests nuevos de RuntimeShutdown mas las regresiones de TradingService.
- Es extraccion PARCIAL de fase 9, no integracion de las mutaciones de stop/cierre,
  exposicion o contabilidad. El lifecycle de startup concurrente con stop y los
  recursos del bootstrap exterior conservan pendientes; no se cambio main.ts.
