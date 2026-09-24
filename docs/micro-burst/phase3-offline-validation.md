# Micro Burst Phase 3 Offline Validation

Date: 2026-09-23

This report separates implementation, test coverage, comparison, and economic
evidence. The candidate remains research-only.

## Status

| Area                   | Status             |
| ---------------------- | ------------------ |
| Phase 3 implementation | COMPLETE           |
| Technical review       | COMPLETE           |
| Economic evidence      | PENDING            |
| Prospective capture    | PREPARED, DISABLED |
| Full serial suite      | 3081/3083; 2 historical hash failures |

## Implementation: COMPLETE

- `MicroBurstOfflineExitVariant` implements explicit `PROBING`, `CONTINUING`,
  `TOLERABLE_PULLBACK`, `DETERIORATING`, and terminal `CLOSING` states.
- Strategic reevaluation at `exitMaxHoldMs` does not close by time alone.
- Absolute exposure remains `exitMaxHoldMs + exitMaxHoldExtensionMs`.
- Safety checks remain first: invalid contract, structural invalidation, anomaly,
  crossed stop, and absolute exposure.
- State reconstruction persists state/deadline/evidence/economic-age diagnostics.
- No runtime adapter, LIVE configuration, stop, target, extension, sizing, leverage,
  or journal path imports the candidate.
- `MicroBurstProspectiveExitObserver` is prepared as a bounded, pure collector;
  activation is disabled and requires a separate adapter review.
- `MicroBurstProspectiveExitCapture` and its bounded JSONL store define the
  reconciled-entry/fill, post-close observation, and restart boundary without
  receiving order authority.
- `MicroBurstProspectiveExitRuntime` provides the reviewed observer-only event
  composition and remains disabled with no call site in `MicroBurstRuntime`.

## Audit Remediation Matrix

| Hallazgo                                          | Reproducción original                                      | Corrección                                                    | Test concreto                                                     | Resultado / límite |
| ------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------- |
| Protección, stops y extensiones divergían         | `MOVE_STOP` LONG/SHORT y protección degradada daban estados distintos | CANDIDATE reutiliza la reducción de protección CURRENT; sólo filtra cierres estratégicos temporales | `MicroBurstOfflineExitVariant.test.ts`; observer LONG/SHORT | Pasa; no implica equivalencia productiva |
| Gap rehabilitaba resultado económico              | Gap persistente seguido de horizonte                         | Resultado económico se marca no evaluable de forma persistente | `MicroBurstProspectiveExitObserver.test.ts` | Pasa; gap posterior a cierre no reabre resultado |
| Replay dependía de inputs en memoria              | Restore retenía decisiones, no observaciones                 | Snapshot incremental conserva observaciones profundas y las reconstruye desde disco | `MicroBurstProspectiveExitCapture.test.ts` | Pasa; no sustituye mercado externo inmutable |
| JSONL truncado permitía continuar append           | Fila válida seguida de tail truncado                         | Append bloqueado, restore sólo conserva filas válidas y diagnostica tail | `MicroBurstProspectiveExitCapture.test.ts` | Pasa; bytes corruptos se preservan |
| Formato incremental ambiguo                         | Snapshot legacy podía aceptarse sin declarar migración      | `formatVersion: 1` obligatorio; legacy/versiones desconocidas se rechazan sin migración | `rejects legacy snapshot rows...` | Pasa; `incompatibleRecords` y `appendBlocked` |
| Identidad/fills incompatibles                       | Duplicado con payload distinto y cantidades incompatibles   | Validación de identidad, rol, cantidad y duplicados idempotentes | `MicroBurstProspectiveExitObserver.test.ts` | Pasa |
| Profundidad insuficiente para cantidad completa     | `quantityCovered` podía aceptarse con cobertura parcial      | Cobertura coherente con la cantidad completa marca segmento no evaluable | `rejects insufficient depth...` | Pasa |
| Copias profundas ausentes                           | Mutar objetos de entrada o salida alteraba el episodio      | Clone al registrar, restaurar y devolver snapshots | `rejects incompatible... protects returned state`; capture replay | Pasa |
| Cierre/métricas no idempotentes                     | Observaciones repetidas, fuera de orden o posteriores al cierre | Duplicados idénticos idempotentes; orden inverso y post-completion rechazados; métricas acotadas | `makes observations idempotent...` | Pasa |
| Start/stop y drenaje concurrentes                   | Start doble y stop durante restore podían solaparse          | Lock/generación de ciclo, cancelación y `drain()` serializado | `MicroBurstProspectiveExitRuntime.test.ts` | Pasa; timeout de drain falla cerrado |

## Coverage: COMPLETE

The directed offline suites cover mirrored LONG/SHORT behavior for:

- favorable continuation through strategic and proof milestones;
- deterioration-confirmed early red exits;
- tolerable pullbacks and safety precedence;
- bounded neutral waiting without deadline restart;
- repeated observations without confirmation inflation;
- degraded economics and missing evidence;
- JSON reconstruction, deterioration timers, and quote age;
- invalidation, anomalies, and absolute exposure.

Current directed result: `48/48` tests passing across the offline variant, observer,
capture, and runtime suites.

Full serial command executed exactly as requested:

```text
npx vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

Result: exit code `1`; `231/232` files and `3081/3083` tests passed. The only
two failures are the pre-existing hash assertions for `src/app/services/TradingService.ts`
at `src/restoration/original-operational-semantics.test.ts:272` and `:278`.
There was no timeout and no unhandled runner error. The complete private log is
retained at `/tmp/opencode/micro-burst-suite-serial-final.log` with SHA-256
`425ec5eda825d1a0e190efcc38dd5ba530f4ebd2af1e9cbcb13f8f8a8ab716bb`.

## Comparison: COMPLETE FOR AVAILABLE FIXTURES

`MicroBurstOfflineExitComparison` replays identical timestamped observations into
CURRENT and the candidate. It now emits each action/reason divergence with:

- observation time;
- both actions, reasons, and diagnostics;
- both time-in-trade values;
- both executable-economics timestamps.

The comparison rejects invalid chronology, missing/stale/uncovered quotes,
unmodeled stop management, and open horizons instead of fabricating outcomes.
The checked fixtures demonstrate the expected strategic divergence at the current
hold milestone: CURRENT closes while the candidate holds; the candidate later
reaches the same absolute `MAX_HOLD` boundary.

No complete production exit-context replay containing all required post-close
inputs is present in the repository. Historical shadow trade/event logs do not
contain the complete executable economics and causal context required by this
comparator. Therefore no production replay is claimed here; such cases are marked
explicitly as `alternativeOutcome: NO_EVALUABLE`, not evidence for or against the
candidate.

## Economic Evidence: NOT EVALUATED

All results are decision-quote marks only. There is no fill simulator, alternate
execution, post-close continuation path, or claim of profitability improvement.
Longer holding time is not treated as economic improvement.

## Remaining TODO

- [ ] Export complete, causally aligned exit-context replays after future research
      runs and run the comparator over every eligible position.
- [ ] Review every divergence with action, reason, evidence age, and timing.
- [ ] Keep incomplete post-close histories explicitly `NO_EVALUABLE`.
- [ ] Do not promote the candidate to LIVE without separate approval and economic
      evidence.
- [ ] Keep prospective capture disabled until the adapter can provide complete
      event/receive/evaluation timestamps, full-depth quotes, and causal gaps.
- [ ] Activate only the separate observer-only composition described in
      `docs/micro-burst/prospective-capture-protocol.md`.
- [ ] Resolve the two owner-authorized historical `TradingService.ts` hash
      expectations separately; they are intentionally not changed by this work.
