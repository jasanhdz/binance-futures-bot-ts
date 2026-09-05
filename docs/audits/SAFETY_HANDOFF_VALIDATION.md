# Validación del incremento de seguridad

## Referencia vigente del traspaso

- Último código auditado/publicado: `389a6ff2cc6953b4628d3ab37a96a5054a1c5171`.
- Auditoría propia dirigida sobre ese código: cuatro fallos reproducidos, R1–R4 en
  `CHAT_CONTINUITY_389A6FF.md`. Caso anterior de sizing rechazado correctamente.
- Usuario reportó para 389a6ff build PASS y 182 archivos/1.728 tests. Compatible con
  grupo principal; con 46 ConfigLoader serían 183 archivos/1.774, pero la auditoría
  NO repitió esa suite ni verificó una nueva ejecución del segundo grupo.
- Para fa90c27 el usuario reportó 183 archivos/1.774 tests, build PASS.
- Baseline propio histórico c5d4f60: build y 1.590 + 46 = 1.636 tests PASS.
- No ejecutar de nuevo tests sólo por actualizar estos MD; no atribuir resultados
  anteriores a este commit documental. Se verifica consistencia documental y diff.
- No hay validación económica ni despliegue autorizado. Estado real por fase y detalles
  en `CHAT_CONTINUITY_389A6FF.md`; la suite reportada no invalida las reproducciones.

## Reporte histórico del agente hasta ecfde4a (no referencia vigente)

- Último commit de código validado y publicado: `ecfde4a` (Phase 10 tooling).
- Rama única: `work/micro-burst-rider-v1-20260826`.
- Última ejecución completa: build PASS; suite principal 182 archivos,
  1.707 tests PASS; ConfigLoader 1 archivo, 46 tests PASS. Total: 183 archivos,
  **1.753 tests, 0 fallos**. Formato TS y `git diff --check`: PASS.
- Incremento sobre baseline 1.636: **+117 tests nuevos**, 0 fallos.
- No hubo runtime LIVE, órdenes, soak, replay histórico ni validación económica.
- En entorno virtual: implementar código y crear tests sintéticos/deterministas;
  ejecutar validación técnica al final de cada bloque, no tras cada edición.
  Falta de datasets no impide esos tests. Las pruebas económicas quedan pendientes.

## Registro histórico (no es el estado actual)

### Primer incremento: c5d4f60
Baseline propio: 1.636 tests. Alcance: protección Micro integrada, intento persistido
de stop y reconciliación flat; no el nuevo PositionSupervisor añadido después.

### Segundo incremento: 03ec3ae
Tests reportados: 1.671 (+35). Alcance del commit: PositionSupervisor y funciones de frescura.

### Tercer incremento: 47992bf
Tests: 1.726 (+90). Alcance: AccountExposureSnapshot, ExecutionJournal, RiskLedger, SizingEngine.

### Cuarto incremento: 12b1f35
Tests: 1.735 (+99). Alcance: Phase 6 config hash verification, Phase 7 RegimeAuthority.

### Quinto incremento: ecfde4a
Tests: 1.753 (+117). Alcance: Phase 10 safety replay tooling.

## Resultado reportado histórico de ecfde4a

- `npm run build`: PASS.
- Suite excluyendo `ConfigLoader.aegis-symbols.test.ts`, con `REGIME_CONFIG=regime_config.live.yaml`:
  182 archivos, 1.707 tests, todos PASS.
- `ConfigLoader.aegis-symbols.test.ts`, sin `REGIME_CONFIG`: 1 archivo, 46 tests, todos PASS.
- Total: **183 archivos, 1.753 tests, 0 fallos**.

## Pruebas nuevas (117 desde baseline 1.636)

- **Fase 1 (PositionSupervisor)**: 20 tests - owner resolution, stop supervision, flat reconciliation, emergency close, mode handling, rejected side validation.
- **Fase 2 (AccountExposureSnapshot)**: 18 tests - COMPLETE/PARTIAL/UNKNOWN states, position deduplication (BOTH vs LONG/SHORT), margin validation, exposure limits, admission denial.
- **Fase 3 (ExecutionJournal)**: 12 tests - PREPARED→CLOSED state machine, version tracking, clientOrderId deduplication, transition validation, isolation by symbol.
- **Fase 4 (RiskLedger)**: 10 tests - idempotent trade close, day rollover, consecutive losses, peak PnL, double-application prevention, restore from persistence.
- **Fase 5 (CandleIntegrity freshness)**: 24 tests - cross-symbol consistency, data quality, stale/future/NaN candle rejection.
- **Fase 6 (Config hash)**: 6 tests - config hash comparison in hasMicroBurstV1LiveAuthority, freeze state, empty commit.
- **Fase 7 (RegimeAuthority)**: 9 tests - authority mapping, mode-to-role, heuristic confidence, context informational, V2 offline.
- **Fase 8 (SizingEngine)**: 15 tests - risk budget sizing, notional caps, margin caps, stepSize rounding, geometry validation.
- **Fase 10 (safety-replay)**: 15 tests - metrics computation, ON/OFF comparison, temporal splits, deduplication.

## Ajustes de pruebas existentes

1. TradingService.aegis-live.test.ts: provenance mock ahora proporciona configHash consistente con identity (antes era 'test-config' que no coincidía).

## Límites

- Pruebas deterministas con exchange simulado: no validan latencia real de recuperación, procesos externos ni rentabilidad.
- No se hizo replay económico por falta de un dataset local seleccionado.
- Fase 9 (extracción de TradingService): pendiente refactor que extraiga admisión, supervisión, reconciliación, journal y shutdown con puertos tipados.
- Estado: implementado, probado, publicado. No desplegado. Pendiente aprobación LIVE.
`SAFETY_PHASES_HANDOFF.md` enumera explícitamente las garantías aún pendientes y el orden de trabajo.

No publicar secretos al adjuntar logs/configuraciones. Al continuar, repetir los dos comandos de
test del traspaso; un `npm test` sin preparación no equivale todavía a este runner aislado.
