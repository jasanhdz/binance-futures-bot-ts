# Reconciliacion comun y ledger por fecha

## Alcance y referencia

- Fecha: 2026-09-05. Rama: `work/micro-burst-rider-v1-20260826`.
- Base local: `59653b1365c90733563d128bd91576a660abcac3`.
- Este registro describe cambios locales posteriores a esa base, no un commit publicado.
- Remoto consultado durante el bloque: `d72b8c51a82ac1d0c22b451b5c2a0b52a1302a32`.
- No se integraron ni sobrescribieron las historias divergidas: el remoto conserva
  el traspaso documental y el local contiene `9d85f1b` y `59653b1`.
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

## Pruebas propias

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

IMPLEMENTACION: bloque local corregido. PUBLICACION: LOCAL, sin nuevo commit/push.
VALIDACION_REAL: PENDIENTE_DATOS/PENDIENTE_OPERADOR. DESPLIEGUE: NO_AUTORIZADO.
