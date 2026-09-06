# Cancelacion durable de protecciones Micro

Base publicada: `3d630296f5583178f8dcc608b75235bb3472b82a`.
Rama unica: `work/micro-burst-rider-v1-20260826`.

## Ruta integrada

TradingService (cierre inteligente o emergencia/reconciliacion MISSING) utiliza
PositionProtectionService.cleanupMicroCloseOrders y el propietario de journal
DurableStopCoordinator.cancelProtection. No se crea otro writer del mismo archivo.
La ruta sin coordinador permanece para consumidores/tests legacy; produccion lo inyecta.

- El protector persiste el bloqueo y hace flush antes de la limpieza, exige dos
  observaciones frescas null y comprueba identidad local antes/despues de esperas.
- Solo ordenes BOT de proteccion del lado correcto pasan al coordinador. El adapter
  consulta orderId standard o algoId exacto, verificando simbolo, side, positionSide,
  tipo, trigger y closePosition/reduceOnly y prefijo BOT. No cancela ordenes ajenas.
- La operacion es hash(scope, parentTradeId, targetOrderId); metadata guarda
  CANCEL_MUTATION_V1, identidad completa y CANCEL_OBSERVED_NOT_POSITION_FLAT.
- Una tarea de cancelacion bloquea admision sincronicamente antes del primer await.
  PREPARED es durable antes de enviar cancelOrderById una sola vez. Timeout o ACK
  no son prueba de cancelacion: se registra UNKNOWN y se consulta identidad exacta.
- Solo CANCELED conduce a CLOSE_PENDING/CLOSED, con fuente EXACT_TARGET_QUERY y
  timestamp persistidos. NEW, FILLED, error o ausencia siguen pendientes. Restart
  valida protocolo/scope/confirmacion y solo consulta; nunca reenvia PREPARED.
- CLOSED se refiere a la mutacion cancelada, no a posicion plana ni PnL. El caller
  reconsulta ordenes supervivientes y posicion fresca antes de finalizar el cierre.
- Listado vacio no permite eludir cancelaciones pendientes de ticks anteriores.
- La persistencia de cierre operativo es compartida: failure final conserva modo
  y bloqueo si aun es su estado, sin sobrescribir una operacion nueva durante flush.
  La cuarentena contable previa se conserva incluso si otro resultado propone borrarla.
- Shutdown espera los transportes/recovery y conserva errores de flush y close.

## Formato y limites

El archivo de stops schema 1 admite ahora operaciones prefijadas cancel:, con
metadata versionada. El codigo nuevo conserva los stops y retirements anteriores;
codigo anterior no interpreta ese protocolo nuevo y no debe abrir el archivo despues
de usarlo. No hay migracion silenciosa, reset de CLOSED ni cambios de fsync/locking.

La API existente entrega evidence de cancelacion por consulta standard/algo con
fixtures del SDK/transporte. No hubo consultas autenticadas ni certificacion de
compatibilidad operativa. Prefijo BOT acredita origen bot, no atribucion universal
de cuenta/trade; la limpieza se limita al protocolo de posicion plana de Micro.

El envio CLOSE_MARKET normal/emergencia sigue pendiente de journal identificado.
Tambien siguen pendientes cambios de brackets con posicion abierta, Aegis/Momentum,
fill accounting completo, reservas monetarias, bootstrap exterior y fase 9 general.
Este bloque no estima/verifica PnL nuevo ni declara que una cancelacion cierre la posicion.

## Validacion propia

`npm run test:safety`: build PASS; 189 archivos / 2.348 tests principales y
ConfigLoader separado 1 archivo / 46 tests. Total **2.394 tests, cero fallos**.
Incluye 27 casos de DurableCancel y dos casos del callback real TradingService con
ACK perdido visible/oculto. Filesystem real: restart, fsync fallido, prueba terminal
corrupta. Tambien covers cambios de identidad, supervivientes, manuales, no reenvio,
cuarentena previa, flush final fallido y drenaje con transporte pendiente.

Se conservaron assertions. Fallos iniciales eran checkpoints/allowlist de la nueva
autoridad y un fixture de prototipo sin el metodo compartido extraido; se corrigieron
con justificacion. La excepcion arquitectonica del coordinador esta acotada a
sendStopCloseOnce y cancelOrderById, no habilita marketOpen ni closeSideMarketSafe.

No bot, PM2, main, LIVE/testnet operativo, orden real, credenciales ni configuracion
LIVE modificada. Implementado/probado localmente para publicar en esta misma rama;
SHA de publicacion se comprueba despues del push. Fases generales siguen PARCIALES.
