# Prompt / Handoff para Codex — Strategy Runtime V2 Phase 1

> **Documento histórico archivado.** Este handoff conserva instrucciones de una fase anterior y no representa el estado ni la autoridad actual del runtime. Consulta el [índice de autoridad documental](../README.md).

> Este documento es una instrucción de implementación. No otorga autoridad live a `MICRO_BURST_V1`.

## Instrucción principal

Trabaja directamente sobre el repositorio:

`jasanhdz/binance-futures-bot-ts`

Rama obligatoria:

`work/micro-burst-rider-v1-20260826`

Antes de modificar cualquier cosa:

```bash
git checkout work/micro-burst-rider-v1-20260826
git pull --ff-only
git status --short
git log -5 --oneline
```

Lee COMPLETOS antes de implementar:

```text
docs/architecture/README.md
docs/architecture/README.es.md
docs/architecture/STRATEGY_CONTRACTS.md
docs/architecture/STRATEGY_CONTRACTS.es.md
docs/architecture/STRATEGY_RUNTIME_V2.md
docs/architecture/MIGRATION_STATUS.md
```

El objetivo NO es construir todavía Micro Burst. El objetivo es **terminar la primera fase de migración arquitectónica del runtime TypeScript** para que Aegis y Momentum sean estrategias independientes sobre servicios compartidos y para que una tercera estrategia pueda agregarse posteriormente sin copiar ni contaminar lógica.

---

# 1. Reglas de Git y autoría — obligatorias

Todos los commits deben aparecer como el usuario del repositorio `jasanhdz`, nunca como `github-actions[bot]` ni otro bot.

Configura el repo local si hace falta:

```bash
git config user.name "Jasan Hernández"
git config user.email "31332180+jasanhdz@users.noreply.github.com"
```

Verifica antes de cada push:

```bash
git log -1 --format='%an <%ae> / %cn <%ce>'
```

NO crees workflows que hagan commits automáticos.
NO uses GitHub Actions como mecanismo de aplicación de parches.
NO hagas force-push salvo que exista una razón técnica extraordinaria y esté documentada.

Haz commits pequeños por frontera arquitectónica, no un mega-commit.

Secuencia recomendada:

```text
1. refactor: route aegis execution through shared core
2. refactor: retire synthetic momentum aegis path
3. refactor: extract strategy position lifecycles
4. fix: harden strategy risk recovery
5. test: stabilize strategy runtime phase one
6. docs: complete phase one migration handoff
```

Puedes combinar 5/6 si el diff es pequeño.

---

# 2. Estado actual que debes asumir

La arquitectura ya tiene las siguientes piezas y NO debes reconstruirlas desde cero:

```text
src/domain/strategy/StrategyIdentity.ts
src/domain/strategy/StrategyDecision.ts
src/domain/strategy/StrategyExecution.ts
src/domain/strategy/StrategyLifecyclePolicy.ts
src/domain/strategy/StrategyPositionOwnership.ts
src/app/strategy/StrategyRouter.ts
src/app/strategy/PositionManagerRouter.ts
src/app/strategy/OwnedPositionManagers.ts
src/domain/risk/StrategyRiskLedger.ts
src/domain/risk/SharedEntrySafetyGate.ts
src/app/services/SharedStrategyExecutionService.ts
src/domain/strategies/momentum-ride/MomentumRideStrategy.ts
src/domain/strategies/momentum-ride/MomentumRideEntryPolicy.ts
```

`TradingService` ya instancia:

- `StrategyRiskLedger`
- `SharedStrategyExecutionService`
- `StrategyRouter<MomentumRideStrategyContext>` para Momentum
- `PositionManagerRouter`
- `AegisPositionManager`
- `MomentumRidePositionManager`

La semántica nueva de propiedad es:

```text
positionOwner: 'BOT'
```

`positionOwner: 'AEGIS'` solamente se tolera al LEER estado persistido antiguo para migración/recovery. No debe escribirse para operaciones nuevas.

Momentum standalone ya puede entrar sin aprobación Aegis y usa `SharedStrategyExecutionService`.

Los tests actuales de runtime importantes están en buen estado:

```text
TradingService.aegis-live.test.ts -> 107/107 PASS
TradingService.exit-eye.test.ts    -> 12/12 PASS
```

No rompas eso.

El `npm test` global actualmente contiene fallos históricos por fixtures externos/ausentes. No interpretes esos fallos como permiso para fabricar archivos científicos. Ver sección de tests al final.

---

# 3. Arquitectura objetivo de Phase 1

Al terminar esta fase deben existir tres capas claras:

```text
                 STRATEGY POLICY
                       |
                       v
              StrategyDecisionEnvelope
                       |
                       v
                 SHARED SAFETY
             (puede vetar, no elegir)
                       |
                       v
             StrategyExecutionIntent
                       |
                       v
             SHARED EXECUTION CORE
                       |
                       v
                    BINANCE
                       |
                       v
              STRATEGY POSITION OWNER
```

Para Aegis:

```text
Aegis/current brain
      -> AegisEntryGuardOrchestrator
      -> Aegis-specific guards
      -> frozen E4 final veto
      -> APPROVED AEGIS INTENT
      -> SharedEntrySafetyGate / account-wide safety where applicable
      -> SharedStrategyExecutionService
      -> AegisPositionManager
```

Para Momentum:

```text
MomentumRideStrategy
      -> MomentumRideEntryPolicy
      -> Momentum-owned risk limits
      -> shared account safety
      -> SharedStrategyExecutionService
      -> MomentumRidePositionManager
```

Prohibido al final:

```text
AegisEntryGuardOrchestrator -> decide usar Momentum
Momentum -> depende de current brain Aegis
Momentum -> depende de CleanEntry Aegis
Momentum -> depende de EntryQuality Aegis
Momentum -> depende de DecisionBrain Aegis
Momentum -> depende de E4 Aegis como estrategia-specific veto
SharedStrategyExecutionService -> decide LONG/SHORT/NO_TRADE
SharedStrategyExecutionService -> llama modelos/brain
SharedStrategyExecutionService -> elige estrategia
```

Una regla de account-wide safety puede vetar cualquier estrategia, pero debe estar declarada como **shared safety**, no disfrazada como guard Aegis.

---

# 4. TAREA A — Migrar ejecución Aegis al SharedStrategyExecutionService

Esta es la prioridad más alta.

Actualmente Aegis todavía conserva gran parte de su apertura/mutación de exchange dentro de `TradingService`.

Debes migrar la **mutación del exchange**, NO la política de Aegis.

## 4.1 Lo que debe permanecer upstream

No muevas al shared execution:

- current brain
- canonical decision
- AegisEntryGuardOrchestrator
- regime context
- RegimeEngineV2 guard
- short gate
- EntryQuality
- EventRisk
- DecisionBrain
- CleanEntry
- ProbeMode
- LongRiskShadow
- E4 tail-risk
- Aegis-specific decision enforcement
- cálculo de si el candidato es A+ o no
- cualquier lógica que decide si Aegis quiere operar

El execution service debe recibir un intent YA aprobado.

## 4.2 Introduce un mapper/factory explícito

Recomendación:

```text
src/domain/strategies/aegis/AegisExecutionIntentFactory.ts
```

o, si necesita dependencias de aplicación:

```text
src/app/strategy/AegisExecutionIntentFactory.ts
```

Responsabilidad:

```ts
approved Aegis decision + exact resolved risk profile + StrategyIdentity
    -> StrategyExecutionIntent
```

Debe ser determinista y testeable.

No recalcules arbitrariamente leverage o position fraction dentro del shared execution si ya fueron resueltos por Aegis.

Campos que el intent debe transportar explícitamente:

```text
identity
tradeId
symbol
side
requestedAt
leverage
positionFraction
stopRoe
takeProfitRoe
metadata/provenance
protection policy if needed
```

## 4.3 Problema actual que debes resolver antes de reutilizar SharedStrategyExecutionService para Aegis

Hoy `SharedStrategyExecutionService` tiene configuración de protección global como:

```ts
requireStop
requireTakeProfit
closeIfProtectionFails
```

pero Aegis tiene configuración por estrategia como `require_brackets` y Momentum tiene sus propios caps.

No queremos que una configuración global del service fuerce el comportamiento de todas las estrategias.

Refactor recomendado:

```ts
interface StrategyProtectionExecutionPolicy {
  requireStop: boolean;
  requireTakeProfit: boolean;
  closeIfProtectionFails: boolean;
}
```

Este policy debe viajar en el `StrategyExecutionIntent` o resolverse explícitamente por estrategia ANTES de llamar execution.

Ejemplo conceptual:

```ts
interface StrategyExecutionIntent {
  ...
  protection: {
    requireStop: boolean;
    requireTakeProfit: boolean;
    closeIfProtectionFails: boolean;
  };
}
```

El service conserva solamente defaults de infraestructura (timeouts/retries/fee buffer), no ownership de estrategia.

Si una estrategia permite operar sin TP o sin brackets, el execution core no debe exigir un `takeProfitRoe` válido innecesariamente. Valida cada campo según el policy real.

No cambies la semántica económica existente de Aegis para hacer que encaje en una interface; adapta la interface a la semántica ya probada.

## 4.4 Preserva exactamente estas propiedades operativas

- set leverage antes de market open
- isolated margin antes de market open
- sizing desde available balance/effective wallet
- fee buffer
- notional cap
- min notional
- quantity rounding/step size
- bounded retries para errores recuperables de tamaño
- no retry de fallos ambiguos de market open
- confirmación de posición después de market open
- emergency close si no se puede verificar
- bracket placement cuando corresponda
- bracket verification cuando corresponda
- emergency close/fail-close cuando mandatory protection falla
- strategy trade ID/provenance
- state write después de una apertura confirmada/protegida según contrato

No cambies valores de SL/TP/leverage/fraction durante esta migración.

## 4.5 Evita duplicación

Después de migrar Aegis, no dejes dos implementaciones vivas para abrir órdenes.

Haz `git grep` de:

```text
marketOpen(
setLeverage(
ensureMarginType(
placeStopClose(
placeTpClose(
```

Clasifica cada mutación restante. Las aperturas de estrategia deben converger en shared execution, salvo operaciones administrativas/recovery claramente justificadas.

---

# 5. TAREA B — Retirar Momentum sintético dentro del AegisEntryGuardOrchestrator

Esto es deuda real de arquitectura.

Actualmente existe:

```text
src/domain/services/aegis-entry/guards/MomentumRideGuardAdapter.ts
```

y `AegisEntryGuardOrchestrator.ts` todavía contiene conceptos como:

```text
'momentum_ride' en ENTRY_GUARD_ORDER
MomentumRideGuardAdapter
momentumGuard
momentumRiskProfile
momentumHardSafety
canMomentumOverrideNonHard
finalStrategy = momentum_ride
strategyCandidates.momentum_ride
```

Ese diseño era útil cuando Momentum vivía dentro de Aegis, pero ya no debe ser la arquitectura final.

## 5.1 Resultado requerido

Una evaluación Aegis debe producir exclusivamente una decisión Aegis:

```text
ALLOW AEGIS
DENY AEGIS
NO_TRADE AEGIS
```

Nunca:

```text
Aegis evaluation -> finalStrategy Momentum
```

La selección/ejecución de Momentum debe venir del strategy runtime/router independiente.

## 5.2 Orden seguro de eliminación

Antes de borrar:

```bash
git grep -n "MomentumRideGuardAdapter"
git grep -n "momentum_ride" src/domain/services/aegis-entry src/app/services/TradingService.ts
git grep -n "finalStrategy" src
```

Clasifica referencias:

- runtime authority
- tests vigentes
- logger/history compatibility
- reporting compatibility
- docs/historical

Primero elimina autoridad runtime.

Si un schema/log histórico necesita seguir leyendo `finalStrategy=momentum_ride`, conserva un parser DTO de compatibilidad, pero NO lógica que pueda volver a seleccionar Momentum.

Una vez cero consumers runtime, elimina el adapter y tests que sólo validaban la arquitectura obsoleta.

No borres datos históricos.

## 5.3 Tests necesarios

Añade/ajusta tests explícitos:

```text
- Aegis abstain nunca se convierte en Momentum dentro del orchestrator.
- Aegis allow sigue siendo Aegis.
- Momentum standalone puede abrir aunque Aegis abstenga, si Momentum y shared safety permiten.
- Un veto shared/account-wide sí puede bloquear Momentum.
- Aegis E4 no se ejecuta como guard de estrategia Momentum standalone.
```

---

# 6. TAREA C — Extraer lifecycle de posiciones fuera de TradingService

Hoy `AegisPositionManager` y `MomentumRidePositionManager` son owners correctos, pero ambos delegan al gran método común de lifecycle dentro de `TradingService`.

Esto debe mejorar sin hacer un rewrite total.

## 6.1 Diseño recomendado

Crea primitives comunes de lifecycle, por ejemplo:

```text
src/app/position/StrategyPositionLifecycleCore.ts
src/app/position/PositionProtectionService.ts
src/app/position/PositionReconciliationService.ts
```

No es obligatorio usar exactamente esos nombres. Prioriza cohesión.

Luego los managers reales deben poseer su composición:

```text
AegisPositionManager
  -> common reconciliation primitives
  -> Aegis break-even/trailing if contract says so
  -> Aegis ExitEye ONLY here
  -> Aegis-specific notifications/metadata

MomentumRidePositionManager
  -> common reconciliation primitives
  -> Momentum break-even/trailing/protection declared by Momentum policy
  -> NEVER Aegis ExitEye
  -> Momentum-specific metadata/logging
```

## 6.2 Qué sí puede ser común

- leer posición actual
- detectar posición desaparecida/cerrada
- reconciliar qty/side
- detectar external size mutation
- safe stop replacement primitive
- bracket inventory/reconciliation
- ROE calculation primitive
- generic break-even math if policy provides threshold
- generic trailing math if policy provides thresholds
- close-safe primitive
- state persistence primitive

## 6.3 Qué NO debe quedar common como autoridad implícita

- Aegis ExitEye
- Aegis decision brain
- Aegis E4
- Aegis strategy switching
- Momentum pattern detection
- estrategia-specific risk decisions

## 6.4 Comportamientos que no puedes romper

Los tests de `TradingService.aegis-live.test.ts` cubren entre otros:

- startup manual position adoption
- bracket preservation
- recreación de stop faltante
- manual LONG/SHORT runtime adoption
- external quantity change tainting
- manual edited SL/TP preservation
- break-even
- trailing
- safe stop movement
- bracket repair
- emergency close
- Phase O counters

No simplifiques esos casos sin entenderlos.

Si conviene, deja la orquestación de adopción manual/recovery en `TradingService` temporalmente y extrae primero sólo lifecycle de posiciones bot-owned.

---

# 7. TAREA D — Recovery y ownership genérico

Objetivo:

Después de restart, una posición debe recuperar su dueño real.

Persistencia nueva debe usar:

```text
positionOwner = BOT
lastStrategy
lastStrategyVersion
lastStrategyHash
lastConfigHash
lastCodeCommitSha
lastStrategyFreezeState
lastTradeId
```

Legacy read compatibility:

```text
positionOwner = AEGIS
```

puede interpretarse como BOT antiguo únicamente cuando hay evidencia suficiente para inferir strategy ownership.

No hagas:

```text
unknown -> asumir AEGIS
unknown -> asumir MOMENTUM
```

Debe ser fail closed:

```text
OWNED
LEGACY_MIGRATABLE
AMBIGUOUS
EXTERNAL
UNKNOWN
```

(o equivalente).

Ambiguous/unknown debe ir a recovery/manual safety, no a un position manager elegido por intuición.

Prueba al menos:

```text
- restart Aegis -> AegisPositionManager
- restart Momentum -> MomentumRidePositionManager
- legacy AEGIS + Aegis tradeId -> migra a Aegis
- legacy AEGIS + Momentum tradeId -> migra a Momentum si el contrato lo permite
- strategyId desconocido -> recovery required
- EXTERNAL/manual -> no se apropia como estrategia automáticamente
```

---

# 8. TAREA E — StrategyRiskLedger: persistencia y reconstrucción

Ya existe `StrategyRiskLedger`.

Audita todos los sitios que todavía usan:

```text
this.tradesToday
this.consecutiveLossTracker
phaseOShortTradesToday
lastExitAt
lastLossAt
```

No elimines contadores legacy sólo por nombre. Clasifica cada uno:

```text
GLOBAL ACCOUNT SAFETY
AEGIS-SPECIFIC
MOMENTUM-SPECIFIC
PHASE-O-SPECIFIC
DISPLAY/TELEMETRY ONLY
DEPRECATED
```

## 8.1 Invariantes

Aegis loss no incrementa Momentum streak.
Momentum loss no incrementa Aegis streak.
Aegis trade no consume Momentum trades/day.
Momentum trade no consume Aegis trades/day.
Shared daily account-loss kill switch puede bloquear ambos.

## 8.2 Startup reconstruction

`restoreClosedOutcomes()` debe auditarse porque recuperar sólo streak no necesariamente reconstruye correctamente `tradesToday`.

No inventes trade opens desde closes si el journal no tiene información suficiente.

Preferencia:

- usa eventos confirmados `TRADE_OPEN`/`TRADE_CLOSE` con strategy provenance si existen;
- reconstruction idempotente por tradeId;
- sólo confirmed bot trades;
- tainted/external trades no contaminan métricas de estrategia;
- día UTC debe ser consistente con runtime existente.

Si el journal actual no permite una reconstrucción honesta de tradesToday, documenta esa limitación y fail-safe antes de crear datos sintéticos.

---

# 9. TAREA F — Congelación/hashes

NO marques todavía `MICRO_BURST_V1` como live.

Aegis y Momentum deben terminar con una ruta clara para hashes reproducibles:

```text
strategy version
strategy implementation hash
strategy config hash
code commit sha
freeze state
```

Requisitos:

- canonical JSON serialization estable para config
- claves ordenadas
- sin timestamps dinámicos dentro del hash
- sin paths absolutos
- sin secretos
- same input -> same sha256

No cambies un hash congelado existente para hacer que un test pase.

Si la identidad Aegis actual usa un migration identity no final, deja `FROZEN_LIVE_CANDIDATE` o estado correcto hasta completar la migración. `FROZEN_LIVE` requiere evidencia explícita, no build verde.

---

# 10. Limpieza adicional permitida

Puedes eliminar módulos, tests, scripts y carpetas deprecados, pero sólo con evidencia.

Criterio mínimo antes de borrar un archivo runtime:

```bash
git grep -n "NombreDelModulo"
git grep -n "ruta/del/modulo"
```

Debe quedar claro que no tiene:

- import runtime
- dynamic import
- package script
- startup hook
- test vigente necesario
- recovery dependency
- config loader dependency

Si sólo es documentación histórica, decide si debe conservarse como historia o eliminarse; no confundir docs con runtime authority.

Ya fueron retirados en esta fase y NO deben recrearse:

```text
LegacyStrategyCompatibility
LegacyStrategyRuntimeFactory
MomentumRideStrategyAdapter
StrategyRuntimeCoordinator
StrategyTelemetry
config/regimen.config.yaml
one-shot cleanup/audit scripts/workflows
```

No recrees una capa `Legacy*` para resolver un problema nuevo.

---

# 11. MICRO_BURST_V1 — prohibido implementarlo en esta fase

`MICRO_BURST_V1` existe sólo como StrategyId reservado.

No crear todavía:

```text
MicroBurstStrategy
MicroBurstEntryPolicy
MicroBurstPositionManager
MicroBurst live config
MicroBurst router registration
MicroBurst order path
```

Al terminar Phase 1 queremos que agregarlo sea sencillo, pero NO lo agregamos aún.

Motivo: primero debemos demostrar que Aegis y Momentum funcionan como dos tenants independientes del runtime compartido.

---

# 12. E4 — no tocar comportamiento científico congelado

No modifiques la lógica/modelo/threshold/features de E4 durante este refactor.

E4 es un downstream veto Aegis existente y debe conservar su comportamiento actual.

Puedes cambiar wiring/DI sólo si los tests demuestran equivalencia, pero no cambies:

- threshold
- feature semantics
- model behavior
- fail-closed semantics
- authority scope Aegis

---

# 13. Tests: qué exigir y qué NO falsear

## 13.1 Obligatorios para esta fase

Al final deben pasar como mínimo:

```bash
npm run build

npx vitest run \
  src/app/services/TradingService.aegis-live.test.ts \
  src/app/services/TradingService.exit-eye.test.ts \
  src/app/strategy/StrategyRouter.test.ts \
  src/app/strategy/PositionManagerRouter.test.ts \
  src/domain/strategies/momentum-ride/MomentumRideEntryPolicy.test.ts \
  src/domain/risk/SharedEntrySafetyGate.test.ts \
  --reporter=dot
```

Añade tests para nuevas factories/services/managers.

## 13.2 Full suite actualmente conocido

El último checkpoint tuvo aproximadamente:

```text
852 passed
10 failed
```

Los 10 fallos restantes son infraestructura/fixtures históricos:

```text
tests/fixtures/brain_manifest.json                     MISSING
config/bundles/aegis-v17-research-artifact-v1.json    MISSING
config/bundles/aegis-prospective-shadow-candidate-v1.json MISSING
regime_config.example.yaml                             MISSING
recentTradeLossAuditCore clean-CI audit DB directory   MISSING
```

No generes JSON falso con hashes inventados para poner verde CI.

Para cada uno debes decidir y documentar una de estas opciones:

```text
A. restaurar artifact auténtico desde fuente autoritativa;
B. convertir test en integration/fixture-required y skip explícito cuando no está disponible;
C. crear fixture mínimo únicamente si el test es de parser genérico y NO pretende equivalencia científica;
D. retirar el test/subsistema si está formalmente deprecado y sin runtime authority.
```

Para `recentTradeLossAuditCore.test.ts`, un empty audit window no debería necesitar una DB real inexistente si el objetivo del test es sólo cargar el módulo. Haz el test hermético con temp dir/fixture controlado si eso representa correctamente la semántica.

Los warnings de `regime_config.yaml` ausente durante algunos tests no necesariamente son failures; evita convertirlos en prioridad de runtime salvo que oculten un bug real.

No ejecutes `npm audit fix` automáticamente durante esta migración. Hay vulnerabilidades reportadas, pero actualizar dependencias en masa es un cambio de riesgo separado.

---

# 14. Performance / latencia

Este bot eventualmente operará una estrategia de timeframes 1m/3m/5m, así que la arquitectura debe evitar latencia innecesaria.

Reglas:

- no HTTP Python para Momentum ni futuro Micro Burst si la lógica es TS determinista;
- no REST candles repetitivo dentro del hot path si ya existe cache/live feed;
- no serializar/deserializar JSON gigante entre layers internas;
- no leer archivos/config de disco en cada tick;
- hashes/config se cargan/resuelven al startup o cambio explícito;
- shared safety y strategy policy deben usar snapshots ya disponibles;
- exchange REST sólo donde sea necesario para mutación/reconciliation;
- evita duplicar `readActivePosition` sin necesidad, pero nunca sacrifiques verificación de seguridad post-order.

No optimices prematuramente eliminando retries de seguridad.

---

# 15. Observabilidad requerida

Cada decisión importante debe poder responder:

```text
qué estrategia decidió
qué versión/hash estaba activa
qué estrategia abrió la posición
qué shared safety veto aplicó
qué execution intent se envió
qué order/trade id se creó
qué position manager posee la posición
por qué cerró/modificó protección
```

Logs Momentum no deben llamarse `aegis_*` salvo que estén leyendo una estructura histórica Aegis explícitamente.

Preferencia de event names:

```text
strategy_entry_intent
strategy_entry_denied
shared_execution_opened
shared_execution_failed
momentum_ride_live_entry
aegis_turbo_live_entry
position_owner_recovered
position_owner_ambiguous
strategy_position_action
```

No renombres en masa eventos históricos si rompe reporting. Agrega compatibilidad de lectura donde sea necesario.

---

# 16. Definición de DONE para Phase 1

No declares terminada esta fase hasta cumplir:

```text
[ ] Aegis approved entries usan SharedStrategyExecutionService.
[ ] Shared execution no contiene lógica Aegis/Momentum de decisión.
[ ] Momentum standalone no depende de AegisEntryGuardOrchestrator.
[ ] AegisEntryGuardOrchestrator ya no puede seleccionar Momentum.
[ ] MomentumRideGuardAdapter fue eliminado o quedó parser-only sin runtime authority.
[ ] AegisPositionManager es owner real del lifecycle Aegis.
[ ] MomentumRidePositionManager es owner real del lifecycle Momentum.
[ ] Aegis ExitEye no puede ejecutarse para Momentum por construcción.
[ ] Restart/recovery enruta correctamente por strategy owner.
[ ] Unknown owner falla cerrado.
[ ] Per-strategy risk no contamina otra estrategia.
[ ] Account-wide safety sigue siendo global.
[ ] New bot state escribe positionOwner=BOT.
[ ] Legacy positionOwner=AEGIS sólo se lee para migration.
[ ] Targeted architecture/runtime tests pasan.
[ ] npm run build pasa.
[ ] Full-suite failures restantes están clasificados, no ocultos.
[ ] No artifact científico falso fue creado.
[ ] No workflow auto-commit existe.
[ ] Commits son de jasanhdz.
[ ] MICRO_BURST_V1 sigue sin implementation/live authority.
```

---

# 17. Entrega final esperada de Codex

Al terminar, responde con un informe compacto pero completo:

```text
PHASE1_STATUS=
HEAD_SHA=
BUILD=
TARGETED_TESTS=
FULL_TESTS=
KNOWN_NON_RUNTIME_FAILURES=

ARCHITECTURE_COMPLETED:
- ...

FILES_ADDED:
- ...

FILES_MODIFIED:
- ...

FILES_REMOVED:
- ...

AEGIS_PATH_NOW:
...

MOMENTUM_PATH_NOW:
...

RECOVERY_PATH_NOW:
...

RISK_OWNERSHIP_NOW:
...

DEPRECATED_RUNTIME_REMOVED:
...

MICRO_BURST_AUTHORITY=false

REMAINING_PHASE2_ITEMS:
- ...
```

Incluye además:

```bash
git status --short
git log -8 --oneline
```

El repo debe quedar limpio al final.

No empieces la estrategia Micro Burst. Primero termina y demuestra esta arquitectura.
