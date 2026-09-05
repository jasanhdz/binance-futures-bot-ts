# Reconciliacion comun y ledger por fecha

## Alcance y referencia

- Fecha: 2026-09-05. Rama: `work/micro-burst-rider-v1-20260826`.
- Base local: `59653b1365c90733563d128bd91576a660abcac3`.
- Bloque publicado en `8306846`, incluido en el merge `d341225b80bf5e1917c34d363d9c5f538b801db5`.
- Publicacion comprobada personalmente consultando la rama remota: `d341225`.
  El merge conserva tanto las correcciones como el traspaso documental de `d72b8c5`.
- R1-R4 de `CHAT_CONTINUITY_389A6FF.md` estan corregidos. Ese traspaso conserva
  evidencia historica, no una lista vigente de esos cuatro fallos.
- No se ejecuto el bot, testnet operativo, LIVE, despliegue ni orden real. No se
  cambiaron configuracion, presupuesto, manifiestos, aprobaciones o credenciales.

## Implementacion

### Supervisor

Archivos: `src/app/position/PositionSupervisor.ts` y su test adyacente.

- El cierre de emergencia reutiliza `reconcileFlat`; no mantiene una segunda
  implementacion de confirmacion, limpieza y cierre local.
- Solo `null` explicito cuenta como flat. Antes de cancelar se requieren dos
  observaciones validas; un error no se olvida al recibir una respuesta posterior.
- Cantidades ausentes, NaN, cero, negativas y lado incompatible no confirman flat.
- Store con `flush`, identidad consistente y bloqueo persistido son requisitos
  antes de cancelar o cerrar. La identidad se revalida despues de esperas de disco.
- Solo se cancelan ordenes BOT. La consulta posterior debe confirmar su ausencia,
  aunque la cancelacion haya sido reconocida. Fallos conservan recuperacion.
- Se exige una nueva lectura flat tras limpiar y persistencia final antes de
  devolver `MISSING`. Un error final de disco devuelve `UNKNOWN` y restaura memoria
  conservadora solo si sigue perteneciendo al mismo estado; nunca pisa otra operacion.
- Cambios concurrentes durante el flush final impiden afirmar cierre confirmado.
- `IDLE` indica cierre operativo, no admision habilitada: conserva identidad,
  ambiguedad, registro de stop y bloqueos, y marca `FLAT_CONFIRMED_ACCOUNTING_PENDING`.
  No estima PnL ni introduce trailing o TP obligatorio en Micro.

### Ledger

Archivos: `src/core/risk/RiskLedger.ts` y su test adyacente.

- Guarda evidencia del ultimo outcome aceptado por `tradeId` y reconstruye PnL,
  contadores, pico diario y racha global en orden `(closedAtMs, tradeId)`.
- `historicalPnl` y `getHistoricalPnl(dayKey)` contienen el total economico conocido
  por fecha UTC, incluido el dia actual, no solo los ajustes recibidos tarde.
- Caso de regresion: +10 ayer, +5 hoy, -25 atrasado de ayer da -15 ayer y +5 hoy.
- `revision` es un entero positivo, por defecto 1. Solo una revision mayor de una
  identidad con evidencia previa corrige importe, fecha o atribucion sin duplicar
  operaciones. Cambiar timestamp no crea una nueva identidad.
- Snapshots y constructor copian mapas, arrays y outcomes. Reinicios mediante JSON
  conservan economia, revisiones e idempotencia sin compartir referencias.
- Validacion previa de identidad, fechas, numeros y overflow; un rechazo no muta
  estado ni consume una revision. Snapshots con evidencia ausente o de forma invalida
  no se convierten silenciosamente en ledger vacio.
- Estados anteriores sin outcomes conservan agregados y claves mediante
  `legacyBaseline`. No se inventa evidencia perdida ni se corrige una operacion legacy
  sin su resultado original. La racha legacy no se reduce por evidencia de orden
  desconocido del mismo dia o anterior; dias posteriores la extienden o reinician.
- Limite temporal aceptado: milisegundos Unix enteros no negativos hasta fin de 9999
  UTC. `netPnl` verificado es el valor economico suministrado por el reconciliador;
  este modulo no verifica fills ni convierte comisiones.

## Pruebas propias del bloque publicado

Comando final ejecutado por el agente coordinador sobre el arbol editado:

```sh
npm run test:safety
```

- Build TypeScript: PASS.
- Grupo principal: 182 archivos, 1.840 tests PASS.
- ConfigLoader separado, sin `REGIME_CONFIG`: 1 archivo, 46 tests PASS.
- Total: 183 archivos, 1.886 tests PASS, cero fallos.
- Supervisor: 89 tests. Ledger nuevo: 59 tests.
- Prettier en los cuatro archivos TypeScript: aplicado. `git diff --check`: PASS.
- La primera ejecucion detecto un tipo opcional de `flush` en un helper de tests;
  se corrigio su contrato requerido. La revision posterior encontro tres casos
  adicionales (racha legacy, snapshot nulo, cambio concurrente en flush final),
  corregidos y cubiertos antes de la ejecucion final.
- El baseline 59653b1 de 1.739 + 46 tests era reporte del otro agente, no una nueva
  ejecucion propia de ese commit. El incremento respecto a ese reporte es 101 tests.

La matriz incluye caminos normal/emergencia, errores mixtos, datos invalidos,
supervivientes con/sin ACK, ordenes ajenas, ausencia/fallo de persistencia,
identidad stale/concurrente, rollover, tardios, correcciones, overflow y reinicio JSON.
Los stores y exchanges son fixtures; reconstruccion serializada no equivale a
prueba de durabilidad de filesystem o transaccion con el exchange.

## Estado y pendientes

| Area | Implementacion del bloque | Integracion | Tests | Siguiente pendiente |
| --- | --- | --- | --- | --- |
| Fase 1 | Reconciliacion comun y regresiones corregidas | Supervisor nuevo aun no runtime | EJECUTADOS_PASS | Journal de cierre, identidad de orden, inventario y consolidacion con proteccion existente |
| Fase 4 | Ledger por fecha, evidencia, revisiones y aislamiento | Ledger nuevo aun no runtime | EJECUTADOS_PASS | Persistencia durable y reconciliacion completa de fills/costes |
| Fase 3 | Sin cambios | Journal anterior sigue pendiente | Sin nueva garantia | Carga, escritura durable, recovery por operacion y reserva bajo incertidumbre |
| Fases 0, 2, 5-10 | Sin declaracion de cierre | Pendientes del traspaso conservados | Regresion global PASS | Continuar dependencias del plan, sin activar LIVE |

El supervisor integrado sigue siendo `PositionProtectionService`, y la sesion de
riesgo runtime sigue usando `StrategyRiskLedger` via `StrategyRiskSessionService`.
Este bloque no sustituye esos componentes ni convierte modulos aislados en garantias
operativas. Tampoco resuelve fencing multihost, respuestas perdidas de cierre o
reenvios entre ciclos: requieren journal por operacion e integracion posterior.

IMPLEMENTACION: bloque corregido. PUBLICACION: PUBLICADO, `8306846` incluido en `d341225`.
VALIDACION_REAL: PENDIENTE_DATOS/PENDIENTE_OPERADOR. DESPLIEGUE: NO_AUTORIZADO.

## Seguimiento posterior a d341225

Dos casos adicionales reportados por la auditoria del usuario se contrastaron con
el codigo y se corrigieron localmente. No reabren los cuatro casos anteriores.

- Reposicion: usa la misma barrera de identidad/persistencia que las otras mutaciones,
  guarda el intento junto al bloqueo y revalida identidad tras el flush y al volver
  de la barrera, inmediatamente antes de invocar el exchange. Si cambia operacion,
  lado, modo, propietario o registro del intento, devuelve UNKNOWN sin enviar stop.
  Tampoco pisa un intento aparecido mientras se esperaban datos de mercado.
- Migracion: la importacion legacy sin version rechaza historia del dia actual como
  ambigua, incluso si su valor coincide con dailyPnl. Historia solo de dias anteriores
  conserva dailyPnl una vez. `version: 1` declara agregados cuyo historico incluye hoy
  y exige igualdad con dailyPnl explicito. `version: 2` es el snapshot exportado con
  outcomes y legacyBaseline normalizado (historia del baseline solo de dias anteriores).
  Snapshots sin version publicados en d341225 siguen admitidos si evidencia y totales
  son consistentes; no se normaliza silenciosamente un baseline con PnL duplicado.
- La proteccion ante escritores concurrentes aqui es local y basada en snapshots;
  no es fencing entre hosts ni una transaccion con el exchange. Journal e integracion
  siguen siendo las siguientes dependencias, sin cambios en este seguimiento.

PUBLICACION DEL SEGUIMIENTO: LOCAL, no incluido todavia en d341225.

### Validacion propia del seguimiento

- `npm run test:safety`: build PASS; 182 archivos y 1.862 tests principales PASS;
  ConfigLoader separado: 1 archivo y 46 tests PASS. Total: 1.908, cero fallos.
- Supervisor: 102 tests; ledger nuevo: 68 tests. Incremento: 22 regresiones sobre
  los 1.886 del bloque anterior, que se conservan como resultado historico propio.
- Casos de reposicion: cambio antes del guardado o durante flush, cada componente
  de identidad, mutacion del input original, intento concurrente, registro borrado
  o alterado, fallo de disco y envio unico con identidad estable LONG/SHORT.
- Casos de migracion: historia ambigua (cero/ganancia/perdida), contrato explicito,
  valores inconsistentes, versiones invalidas, compatibilidad de snapshots d341225,
  no mutacion del input, rollover, cierres tardios y reconstruccion JSON.
- Estos resultados fueron ejecutados por el coordinador sobre los cambios locales;
  no se atribuyen al merge d341225 ni a una ejecucion de la auditoria del usuario.
- Formato TypeScript y `git diff --check` comprobados al finalizar.
