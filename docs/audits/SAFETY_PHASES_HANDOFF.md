# Traspaso a Codex: endurecimiento por fases

## Alcance y reglas

- Repositorio: `jasanhdz/binance-futures-bot-ts`.
- Rama única: `work/micro-burst-rider-v1-20260826`. No crear otra rama.
- Baseline histórico auditado: `05b233963d7897dccb9912f82b76895270eeb3b0`.
- Último código auditado: `389a6ff2cc6953b4628d3ab37a96a5054a1c5171`.
- Leer primero `CHAT_CONTINUITY_389A6FF.md`: historial, cuatro reproducciones abiertas,
  estado real de fases y orden inmediato. Las tablas de c5d4f60 inferiores son históricas.
- Este documento acompaña un incremento PARCIAL de seguridad, no certifica todas las fases.
- El usuario pide completar el código de TODAS las fases y crear sus tests desde un
  entorno virtual, con commits y publicación incremental. No esperar datasets para programar.
- Agrupar implementación y creación de tests; ejecutar la validación técnica al FINAL
  de cada bloque publicable y una regresión global final. No ejecutar replay/soak aquí.
- Leer `AGENTS.md`, el diff del incremento y las implementaciones actuales antes de editar.
- No iniciar `main.ts`, PM2, servicios LIVE, soak, órdenes Binance ni cambiar credenciales.
- Publicar código NO autoriza desplegarlo. Preservar configuración LIVE, presupuesto y modos.
- Micro conserva su salida inteligente: no reintroducir trailing ni TP obligatorio.
- No declarar rentabilidad por tests técnicos ni calibrar sobre el conjunto final de evaluación.
- No borrar trabajo local, no `git reset --hard`, no force push, no aprobar modelos mediante hashes inventados.

## Estado entregado (no confundir incrementos con fases completas)

### Estado auditado en 389a6ff — referencia actual

- Las fases NO están completas salvo refactor: módulos nuevos siguen sin integración
  runtime comprobada; journal durable, contabilidad, régimen y replay siguen parciales.
- R1: reaparecimiento todavía produce RECOVERY_REQUIRED con mode IDLE por callers que
  omiten preservePositionState. Quitar transición a IDLE del helper general.
- R2: timeout seguido de lista vacía borra lastError y permite reposición. Conservar
  incertidumbre de la ventana salvo evidencia positiva de stop.
- R3: post-cancel se consultan órdenes pero se cuentan NO BOT; un BOT superviviente
  no bloquea finalización. Exigir verificación de limpieza propia y tratar errores.
- R4: cierre atrasado no aumenta tradesToday, pero añade PnL de ayer a dailyPnl actual.
  Atribuir por fecha económica, no por recepción.
- Mejoras verificadas: el caso de sizing maxLoss tras redondeo ya se rechaza; contrato
  de frescura separa historial y última vela. Falta validación/integración integral.
- FileBackedExecutionJournal sigue sin cargar archivo, máquina por símbolo y escritura
  no atómica. No integrar antes de resolver reinicio, segunda operación y fallos de disco.
- Prioridad: R1–R4, journal, integración vertical de cuenta/ejecución/protección/contabilidad,
  después completar 5–10. Detalle y pseudocódigo en CHAT_CONTINUITY_389A6FF.md.
- Auditoría dirigida: sin cambios de código ni nueva ejecución de suite completa.
  Usuario reportó build PASS y grupo principal 182 archivos/1.728 tests; 46 adicionales
  de ConfigLoader deben verificarse antes de afirmar total propio de 1.774.

### Contrato de continuación virtual — prevalece sobre notas históricas inferiores

Leer también `CODEX_CONTINUE_SAFETY_PROMPT.md`. Finalizar implementación no significa
aprobar económicamente, operacionalmente o para LIVE. Registrar por fase:

- IMPLEMENTACION: PENDIENTE / PARCIAL / COMPLETA (con rutas y commit).
- TESTS: CREADOS / EJECUTADOS_PASS / FALLIDOS / NO_EJECUTADOS (comando y resultado).
- VALIDACION_REAL: PENDIENTE_DATOS / PENDIENTE_OPERADOR / NO_APLICA.
- PUBLICACION: LOCAL / PUBLICADO (SHA remoto verificado). DESPLIEGUE: NO_AUTORIZADO.

No usar un único check para ocultar esos estados. No llamar COMPLETA a implementación
con stubs, TODO de lógica crítica o módulos sin cablear al runtime aplicable. En los
componentes experimentales de fases 7/8, dejar el contrato probado y la activación
pendiente de aprobación; no alterar silenciosamente la política LIVE.

| Fase | Estado al partir de c5d4f60 | Trabajo que debe programarse ahora |
| --- | --- | --- |
| 0 | Avanzada | Corregir documentación y mantener runner reproducible; evidencia externa queda pendiente |
| 1 | Parcial | Supervisor común, inventario completo, identidad de órdenes y recovery durable general |
| 2 | Parcial | Snapshot completo, reservas de riesgo persistentes, revalidación y escritor único |
| 3 | Parcial | Journal previo a aperturas/cierres, recovery al arrancar, fallos de disco/timeout de apagado |
| 4 | Pendiente de completar | Fills atribuibles/paginados, costes verificables y ledger idempotente |
| 5 | Parcial | Validación temprana común, cierre/frescura/cadencia y alineación temporal |
| 6 | Pendiente | Identidad y hash efectivos, manifiesto no circular, no autoaprobación |
| 7 | Parcial | Semántica real de indicadores y modos, paridad legacy/V2, autoridad única |
| 8 | Pendiente | Motor parametrizado de riesgo/ejecución; presupuesto y activación quedan para el propietario |
| 9 | Pendiente | Extracción de orquestación con paridad y puertos tipados |
| 10 | Pendiente | Tooling de replay/evaluación completo y tests sintéticos; resultados económicos pendientes |

Orden de implementación: 0; ciclo crítico 1/2/3 coordinado con prioridad al journal
y reconciliación; 4; 5/6; 7/8; consolidación 9; tooling 10. La falta de datos o una
aprobación de parámetros se registra sin bloquear otros trabajos independientes.
Las dudas que impliquen permisos, pérdida de datos o política LIVE sí requieren consulta.

### Segundo incremento 2026-09-05 sobre `fbc7f19`

- La supervisión runtime Micro recibe su StateStore. Antes de enviar un stop de
  reposición persiste y hace flush de `microStopSubmission`; si falla, no envía.
  Una respuesta perdida devuelve UNKNOWN y el registro impide repetir el envío
  en ciclos posteriores/reinicio. La supervisión por símbolo tiene exclusión local.
- Se conserva el instante original: tras 30 s sin confirmación y con lecturas
  de posición/órdenes disponibles se solicita recuperación explícita, no otro stop.
  El plazo es inyectable. Un fallo de lectura sigue siendo UNKNOWN: no prueba
  ausencia de stop ni autoriza por sí solo un cierre. El puerto aún no permite
  correlacionar un clientOrderId propio de stop: ese trabajo sigue pendiente.
- `microProtectionBlocked` es independiente de `marketOpenAmbiguous`. Confirmar
  un stop no borra ambigüedad de entrada ni PnL pendiente. La admisión Micro/Aegis
  consulta cuarentenas de los estados configurados/cargados antes de nuevas entradas.
  No equivale todavía a consultar todo el inventario de cuenta o de disco.
- MISSING se reconcilia antes de indicadores: dos lecturas flat, limpieza sólo de
  órdenes BOT, verificación de supervivientes y nueva lectura de posición. El cierre
  de emergencia reutiliza ese camino. Sólo null explícito cuenta como flat.
- Tras confirmación se conserva identidad, se pasa a IDLE y se persiste PnL pendiente;
  no se inventan fills/PnL ni se actualizan rachas. Una posición cerrada deja de ser
  una posición local fantasma, pero sigue bloqueada la admisión por contabilidad.
- FsStateStore valida y conserva el registro de stop. Los digests de fuente de
  TradingService/FsStateStore se actualizan por estos contratos, sin autorizar LIVE.
- Validación al final del bloque: `npm run test:safety` correcto; build y
  1.590 + 46 = 1.636 pruebas aprobadas, 15 casos adicionales sobre `fbc7f19`.
  Formato TypeScript y `git diff --check` correctos. No se ejecutó el runtime LIVE.
- Pendientes prioritarios: journal de apertura/cierre con identidad estable; inventario
  universal; supervisión independiente del scheduler de estrategia; reconciliación
  contable idempotente; escritores múltiples y reservas de riesgo. No cerrar fases
  1–4 ni activar producción basándose sólo en estos incrementos.

### Incremento local 2026-09-05 sobre `5c35190`

- Fase 2: corregida liberación de reservas antiguas mediante token por lease y
  liberación idempotente local. Regresiones cubren readquisición del mismo símbolo
  y de otro símbolo. Sigue siendo exclusión dentro de un proceso, no reserva durable de riesgo.
- Fase 1: la confirmación del stop ahora reintenta también errores de lectura dentro
  del límite existente. Sólo evidencia positiva confirma protección; errores seguidos
  de respuestas vacías conservan UNKNOWN sin enviar otro stop. No reintenta envíos.
- Fase 3: entradas Micro/Aegis y gestión por símbolo quedan registradas como tareas;
  stop cierra admisión, detiene productores, espera esas tareas y después hace flush.
  No admite nuevos ticks durante el apagado. Conserva el timeout exterior de 15 s
  del bootstrap: NO garantiza durabilidad si ese plazo vence o el proceso cae.
- El digest de TradingService en restoration se actualiza como checkpoint de fuente,
  no como autorización LIVE. No se modifican estrategias, presupuesto o manifiestos.
- Verificación: `npm run test:safety` correcto, build y 1.575 + 46 = 1.621 pruebas
  aprobadas. Ocho casos nuevos respecto al baseline. Las regresiones de lease fallaron
  antes de la corrección; se conserva el test de adquisición síncrona del lock Micro.
  Formato de archivos TypeScript modificados y `git diff --check` correctos.
- Las fases 1, 2 y 3 siguen PARCIALES. Siguientes prioridades: recovery durable de
  protección con plazo e identidad de orden; reconciliación independiente de MISSING;
  journal previo al envío y recovery tras timeout/crash; exposición global y reservas
  pendientes; contabilidad idempotente. Después continuar fases 5 a 10.

- [x] Micro solicita cierre de emergencia si falla el stop obligatorio después de abrir.
- [x] Si falla la recuperación y se informa posición abierta, se conserva identidad Micro, lado,
      stop y destino en el estado; se excluye de métricas y se mantiene bloqueo por ambigüedad.
- [x] `ensureMicroStop` consulta posición y órdenes antes del contexto de salida; restaura
      un stop de posición completa sin TP y exige verlo listado. Error/visibilidad pendiente:
      cuarentena de entradas y alerta; no se afirma protección confirmada.
- [x] Posiciones gestionadas con modo de entrada OFF/SHADOW siguen pasando a gestión si el
      almacenamiento está acotado por símbolo o solo existe un símbolo configurado.
- [x] Micro comparte `entryInFlight` con Aegis/Momentum durante toda la admisión/ejecución.
- [x] La lectura de exposición ya propaga un fallo en vez de convertirlo en posición inexistente.
- [x] `CandleIntegrity.ts` valida OHLCV, timestamps y cadencia original. Micro incorpora esa
      validación en `dataQuality`; no se conectó aún a todos los proveedores o al régimen legacy.
- [x] Pruebas nuevas de stop, exclusión, error de exposición, orden de supervisión y velas.
- [x] Reparaciones de fixtures anteriores: cuarentena alcanza su guard con provenance simulada;
      fallo de listado se distingue de retraso de visibilidad; tamaño predeterminado esperado 0.9.
- [x] Se actualizan los digests de fuente `TradingService` y `FsStateStore` en restauración,
      con motivo explícito. No se cambia ningún manifiesto de aprobación LIVE.
- [ ] Supervisión universal, recuperación durable y reconciliación externa: NO terminadas.
- [ ] Resto de fases: seguir el checklist inferior; no marcar todo como resuelto.

### Limitaciones importantes del incremento

1. La supervisión runtime hace confirmación acotada y persiste el intento de stop
   con plazo entre ciclos/reinicios. Falta correlación por identidad de orden y un
   journal general de recovery; UNKNOWN por lecturas fallidas no prueba ausencia de protección.
2. El error de supervisión actualmente retorna antes de la salida inteligente. Diseñar en fase 1
   una vía de emergencia independiente: no dejar una posición abierta indefinidamente a base de alertas.
3. MISSING ya tiene reconciliación operativa independiente de la señal de salida;
   la reconciliación contable de fills/costes sigue pendiente. Nunca inferir PnL del mark price.
4. La ambigüedad no se borra automáticamente al reponer un stop. Es intencional: confirmar
   protección no prueba que una apertura ambigua o su contabilidad estén reconciliadas.
5. El bloqueo compartido es local al proceso; no resuelve dos procesos o reinicios.
6. Exposición sigue limitada a símbolos LIVE configurados. No es aún un snapshot de cuenta completo.
7. `dataQuality` se construye después de algunos cálculos: se bloquea la entrada, pero falta
   validación temprana antes de indicadores y propagación homogénea a todos los consumidores.
8. Aegis permite temporalmente SL+TP reconocidos aunque no visibles: no cambiar ese contrato
   sin prueba específica y reconciliación con plazo. No equivale a garantías universales.

## Verificación reproducible, sin credenciales

Usar dependencias del lockfile; no arrancar el bot para probar.

```sh
npm run build
REGIME_CONFIG=regime_config.live.yaml npx vitest run --silent --exclude src/infra/config/ConfigLoader.aegis-symbols.test.ts
env -u REGIME_CONFIG npx vitest run src/infra/config/ConfigLoader.aegis-symbols.test.ts --silent
git diff --check
```

Motivo de los dos grupos: sin `REGIME_CONFIG` algunos imports buscan un YAML local no versionado;
con esa variable el ConfigLoader sobrescribe los YAML temporales de sus propios tests. No contar
los fallos inducidos por esa mezcla como bugs del algoritmo. Fase 0 debe dejar un runner hermético.
Consultar `SAFETY_HANDOFF_VALIDATION.md` para resultados del incremento entregado.

## Fase 0 — Contratos y baseline reproducible

Archivos: `vitest.config.ts`, `src/infra/config/ConfigLoader.ts`,
`src/restoration/original-operational-semantics.test.ts`, bootstrap y `TradingService.ts`.

- [x] Capturar SHA, árbol, config efectiva SANITIZADA y todos los tests antes de modificar. Ver
      `SAFETY_PHASE0_BASELINE.md`.
- [ ] Confirmar en local si existe supervisor externo de brackets no versionado aquí; documentar
      proceso, frecuencia, símbolos, condiciones y evidencia. No asumir existencia = cobertura.
- [x] Escribir matriz estrategia/modo/posición existente: quién puede abrir, cerrar y proteger.
      Ver `SAFETY_PHASE0_BASELINE.md`.
- [x] Hacer pruebas independientes de variables/YAML privados sin cambiar precedencia de producción.
      `npm run test:safety` separa ambos grupos.
- [x] Conservar assertions de seguridad y justificar cada actualización de fixture/digest.

```text
para cada estrategia y modo:
    separar permiso_de_entrada de obligación_de_proteger_posición_existente
    identificar propietario y política (Micro: stop sí, TP no, trailing no)
    ejecutar contrato con exchange simulado y comprobar llamadas/prohibiciones
```

Cierre parcial: suite reproducible en checkout limpio y contratos escritos, no solo build verde.
La confirmación de supervisor externo sigue bloqueada por falta de evidencia local.

## Fase 1 — Protección y ciclo de vida independiente

Archivos: `src/app/position/{PositionProtectionService,PositionRecoveryService,StrategyPositionLifecycleCore}.ts`,
`src/app/services/TradingService.ts`, `MicroBurstPositionManager.ts`, `SharedStrategyExecutionService.ts`.

- [ ] Extraer un supervisor común de seguridad, separado de las decisiones de salida.
- [ ] Revisar cobertura: cantidad, lado, posición hedge/one-way, tipo/estado de orden y trigger.
- [ ] Validar stop contra precio vigente y filtros; no degradar un stop más protector existente.
      Micro ahora rechaza precio ausente o stop con riesgo de trigger inmediato; la validación
      completa de filtros y la protección existente siguen pendientes.
- [ ] Confirmación con reintentos acotados: Micro reintenta la visibilidad del stop y rechaza
      órdenes explícitamente `UNKNOWN`; intentos/espera son inyectables. Micro persiste el
      intento antes de enviarlo; faltan identidad de orden, journal general y supervisor común.
- [ ] Posición cerrada por stop/exchange/manual: reconciliar independientemente del contexto técnico.
      Micro ya reconcilia flat y órdenes propias sin indicadores y mantiene PnL pendiente;
      falta extender el contrato a todas las estrategias e integrar contabilidad verificada.
- [ ] Fallo de protección: recuperar o cerrar con cantidades frescas; si el cierre falla, persistir
      `RECOVERY_REQUIRED`, bloquear nuevas entradas y alertar. Micro separa UNKNOWN/MISSING/
      CONFIRMATION_PENDING de RECOVERY_REQUIRED, limpia sólo órdenes propias tras flat confirmado
      y marca PnL no verificado sin inventarlo; estados durables y recovery explícito siguen pendientes.
- [ ] Supervisar posiciones aunque cambien símbolos/modos habilitados: recorrer también inventario
      persistido y cuenta, sin mutar símbolos SHADOW que solo heredan estado global ambiguo.

```text
supervisar(posición_con_propietario):
    lectura = consultar_exchange()
    si error: mantener UNKNOWN; bloquear admisión; reintentar/alertar
    si flat confirmado: reconciliar fills/cierre; no esperar indicador
    si abierta:
        política = protección_del_propietario
        si stop válido cubre cantidad: marcar PROTECTED
        si falta: colocar/reponer sin quitar protección útil anterior
        confirmar por identidad de orden dentro de un plazo
        si sigue sin protección: intentar cierre de emergencia y confirmar flat
        si cierre ambiguo: persistir RECOVERY_REQUIRED; nunca resetear a IDLE
```

Tests: ambos lados; solo stop Micro; stop rechazado; listado tardío; cantidad parcial; orden ajena;
error de cuenta; posición externa; mercado ausente; OFF con posición real; cierre fallido/reinicio.
Cierre: ninguna posición abierta queda olvidada y ninguna orden se considera confirmada por log.

## Fase 2 — Admisión, concurrencia y exposición

Archivos: `TradingService.ts`, `SharedStrategyExecutionService.ts`, `SharedEntrySafetyGate.ts`,
`AegisPortfolioRiskGuard.ts`, coordinadores de entrada.

- [ ] Convertir booleanos compartidos en una reserva explícita común con liberación garantizada.
      Existe `SharedEntryReservation` local con token por lease, liberación idempotente
      y pruebas de release antiguo después de readquirir, con uso en admisión Micro/Aegis;
      los booleanos legacy y la exclusión entre procesos siguen pendientes.
- [ ] Revalidar posición y exposición dentro de la reserva, justo antes de enviar.
- [ ] Snapshot de cuenta completo: no limitarlo a símbolos habilitados, no duplicar BOTH en hedge.
- [ ] Representar COMPLETE/PARTIAL/UNKNOWN y rechazar datos no finitos. Error no significa cero.
      El snapshot Aegis ahora rechaza posiciones y mark prices inválidos; aún no representa
      estado COMPLETE/PARTIAL/UNKNOWN ni consulta inventario global de cuenta. También rechaza
      margen aislado inválido y totales no finitos; margen ausente se estima explícitamente.
- [ ] Reservar margen/riesgo de intenciones pendientes entre símbolos; evitar sobreasignación.
- [ ] Definir exclusión entre procesos o impedir segundo escritor sobre misma cuenta/estado.

```text
admitir(intención):
    adquirir reserva de cuenta/símbolo (o devolver BUSY)
    try:
        si shutdown o recovery pendiente: denegar
        exposición = leer cuenta completa + reservas pendientes
        si no COMPLETE: denegar EXPOSURE_UNKNOWN
        si ya hay posición/orden incompatible: denegar
        evaluar riesgo; reservar presupuesto
        enviar una sola intención con ID estable
    finally:
        liberar reserva solo cuando riesgo pendiente esté resuelto o transferido a recovery
```

Tests: Micro vs Aegis/Momentum simultáneos, dos símbolos, error/rechazo y liberación, timeout
de orden sin doble envío, NaN en riesgo, posiciones fuera de la lista LIVE.

## Fase 3 — Durabilidad, apagado y recuperación

Archivos: `FsStateStore.ts`, `StateStore.ts`, `main.ts`, `TradingService.stop`,
`MicroBurstRuntime.stop`, ejecución compartida. `src/tooling/legacy-execution/durable/`
es material de referencia: no asumir que ya protege el runtime.

- [ ] Persistir intención/identidad/clientOrderId ANTES del envío y transiciones después.
- [ ] Seguimiento explícito de promesas de entradas, gestión y evaluaciones.
- [ ] Apagar: bloquear admisiones, drenar tareas, reconciliar, flush, cerrar recursos.
      `TradingService.stop()` ya cierra `acceptingEntries` antes de detener productores y
      espera tareas registradas de entrada/gestión antes de flush. El bootstrap limita
      la espera a 15 s; falta persistir/reconciliar pendientes si vence y completar recovery.
- [ ] Error de escritura debe impedir nuevas entradas; archivo atómico no es transacción exchange.
- [ ] Recovery idempotente tras cada ventana de caída; conservar eventos no reconciliados.

```text
PREPARED -> SUBMITTED -> OPEN_CONFIRMED -> PROTECTED -> CLOSE_PENDING -> CLOSED
                    \-> UNKNOWN/RECOVERY_REQUIRED

arrancar:
    cargar journal durable; reconciliar IDs/posiciones/órdenes
    habilitar admisión solo cuando no queden conflictos relevantes
apagar:
    acceptingEntries = false
    detener productores; esperar tareas en curso con plazo explícito
    persistir pendientes y errores; flush; cerrar
```

Tests de crash injection antes/después de cada transición, error de disco, SIGTERM durante
marketOpen/stop, respuesta perdida y restart sin duplicación. No hacer kill de procesos LIVE.

## Fase 4 — PnL reconciliado y riesgo diario

Archivos: callback close de Micro en `TradingService`, `getRecentFills` en `BinanceAdapter`,
`AegisClosedTradeHistoryReader`, `StrategyRiskSessionService`, `StrategyRiskLedger`.

- [ ] Asociar fills por IDs de orden/trade/positionSide, tiempo y cantidad; paginar y deduplicar.
- [ ] Comparar cantidad cerrada total con cantidad ejecutada; un fill no basta para verificar.
- [ ] Separar bruto, comisiones de entrada/salida y funding cuando aplique al contrato neto.
- [ ] Convertir moneda de comisión con evidencia; ausencia de conversión = neto no verificado.
- [ ] Estado de cierre y de contabilidad separados; no reapertura con PnL crítico pendiente.
- [ ] Actualizar rachas/límites exactamente una vez y recuperar resultados de forma idempotente.

```text
reconciliar(trade):
    fills = paginar por órdenes relacionadas, deduplicar por fillId
    si cantidad o atribución incompletas: ACCOUNTING_PENDING
    bruto = suma realizedPnl atribuible
    costes = comisiones verificadas en moneda común + funding atribuible según contrato
    neto = bruto - costes
    persistir resultado y evento idempotente
    aplicar riesgo una sola vez por tradeId/version de cierre
```

Tests: múltiples fills, más de 100, comisión no USDT, hedge opuesto simultáneo, parcial,
duplicado/restart, fill tardío, cierre sin operación manual de la estrategia, medianoche.

## Fase 5 — Integridad temporal y numérica

Archivos: `CandleIntegrity.ts`, `MicroBurstContextBuilder`, `CandleDataPlane`,
`MarketDataCandleProvider`, `RegimeDataIntegrity`, `RegimeContextGuardAdapter`.

- [ ] Validar antes de indicadores y antes de descartar velas; conservar razón y evidencia.
- [ ] Unificar contratos sin imponer closeTime a datasets que solo tienen openTime: adaptadores explícitos.
- [ ] Validar cadencia 1m/3m/5m, OHLCV, duplicados, fechas, velas cerradas y frescura con reloj inyectado.
- [ ] Distinguir tiempo de evento, recepción y decisión; limitar desfase entre símbolo y BTC/ETH.
- [ ] No ordenar/deduplicar/rellenar silenciosamente para fabricar un contexto sano.

```text
datos = leer proveedor
validar forma y orden original
separar vela en formación mediante contrato explícito
validar continuidad/cierre/frescura del historial requerido
si error: INVALID(reason); no calcular decisión operable
calcular indicadores únicamente sobre ventana validada
```

Tests: fixture con gap y volumen negativo rechazado en builder real, último candle abierto,
timestamp futuro, reloj desfasado, serie antigua recién recibida, NaN y contexto BTC stale.

## Fase 6 — Identidad y configuración efectivas

Archivos: `MicroBurstIdentity.ts`, `TradingRuntimeConfigService.ts`, configuración/arranque.

- [ ] Resolver hash de configuración ignorado en `hasMicroBurstV1LiveAuthority`.
- [ ] Separar SHA de build, hash de contenido de estrategia y manifiesto aprobado (evitar hash circular).
- [ ] Registrar valores efectivos, no constantes que describen otra versión.
- [ ] No usar SHA antiguo en ENV para superar una denegación del commit actual.
- [ ] Config incompatible bloquea NUEVAS entradas, no seguridad de posiciones existentes.
- [ ] Aprobación de parámetros LIVE requiere elección del propietario; no autoaprobar para pasar tests.

```text
efectivo = canonicalizar(config resuelta)
declarado = manifiesto aprobado
permitir entradas solo si modo, identidad, hash efectivo y artefacto cumplen declarado
si mismatch: NO_NEW_ENTRIES con diferencias sanitizadas; mantener supervisor
```

Tests: orden de claves equivalente, parámetro modificado, manifiesto ausente, SHA inválido,
deploy nuevo no aprobado, restore de posición creada por versión anterior.

## Fase 7 — Régimen y semántica de indicadores

Archivos: `AegisRegimeGuard`, `RegimeGuardAdapter`, `RegimeContextGuardAdapter`,
`AegisEntryGuardOrchestrator`, `RegimeEngineV2`, scripts de auditoría.

- [ ] Dibujar autoridad real: legacy clasifica runtime; V2 es análisis offline actualmente.
- [ ] Calcular EMA mid/slow, pendiente real de EMA y ventanas configuradas, o quitar campos engañosos.
- [ ] Validar edad ausente/NaN/futura con contrato; distinguir UNKNOWN de CHOP y baja confianza.
- [ ] Resolver `regime_context` informativo aunque ENFORCE: modo honesto, no activar veto por sorpresa.
- [ ] Mantener OFF/SHADOW/ENFORCE y razón raíz; nunca resucitar lista SHORT en workflow.
- [ ] Confidence heurística no es probabilidad. Comparar legacy/V2 antes de migrar autoridad.

```text
contexto técnico = clasificador(datos válidos)
decisión riesgo = política(contexto, lado, config)
si OFF: no veto
si SHADOW: registrar wouldBlock sin bloquear
si ENFORCE: aplicar decisión; UNKNOWN según contrato fail-closed
workflow consume decisión final; no interpreta metadata como segunda política
```

Tests: ventanas modificadas cambian indicador correcto; EMA slope no igual a retorno de cierre;
todos los modos con contexto ausente/inválido; spies marketOpen; razones originales preservadas.

## Fase 8 — Presupuesto y geometría ejecutable

En virtual implementar motor puro y adaptadores con presupuesto de fixtures. No elegir
un presupuesto LIVE por el usuario ni reemplazar el default 0.9 sin aprobación. Registrar
implementación completa y activación pendiente como estados separados cuando corresponda.

Archivos: `MicroBurstEntryPolicy`, `MicroBurstLeveragePolicy`, intent factory, ejecución.

- [ ] Pedir presupuesto autorizado de pérdida por trade/cuenta antes de cambiar exposición LIVE.
- [ ] Mantener 0.9 como baseline actual, no asumir que 0.09 era política autorizada.
- [ ] Sizing por distancia al stop + costes y caps; apalancamiento no sustituye límite de pérdida.
- [ ] Revalidar con quote ejecutable/fresco y luego con fill; target/stop no deben quedar al revés.
- [ ] Validez temporal de intención; no refrescar solo requestedAt ocultando una señal antigua.

```text
riesgoUnitario = abs(precioEjecutable - stop) + costeConservadorPorUnidad
qty = floorStep(min(presupuestoPerdida / riesgoUnitario,
                    capMargen * leverage / precioEjecutable, capNotional / precioEjecutable))
si stale, geometría inválida, qty/minNotional inválidos o reserva excedida: NO_TRADE
si fill cambia geometría: ejecutar política de recuperación explícita
```

Tests: stop cercano/lejano, ambos lados, cambios de spread, precio cruza target, filtros no
decimales simples, qty redondeada sin exceder presupuesto, costes mayores que edge bruto.

## Fase 9 — Arquitectura sin cambiar estrategia

- [ ] Extraer admisión común, supervisión, reconciliación contable y shutdown de `TradingService`.
- [ ] Puertos tipados; evitar `any` para esquivar contratos de propiedad y recovery.
- [ ] Separar observación/research de autoridad de mutación; un solo escritor por cuenta.
- [ ] Tests de paridad de decisiones e intenciones antes/después; mantener interfaces estables.
- [ ] Distinguir docs históricas/propuestas de código ejecutado; quitar nombres de autoridad falsos.

```text
TradingService coordina:
    AdmissionService + PositionSupervisor + StrategyExitRouter + ExecutionJournal + RiskSession
estrategia produce decisiones puras
infraestructura ejecuta contratos, nunca decide dirección por su cuenta
```

## Fase 10 — Evidencia económica, no ajuste a ciegas

Alcance virtual: terminar loaders con contratos/esquemas, CLI, replay causal, comparador,
métricas, exportes y tests sintéticos. Sin datos reales devolver INSUFFICIENT_DATA o
PENDING_REAL_DATA; no fabricar métricas ni declarar NO_EDGE sin evaluación válida.
Es posible completar el tooling, no la evidencia económica real en este entorno.

Archivos: tooling de régimen, `MicroBurstOutcomeEngine/Tracker`, blackbox, paper y analyzers.

- [ ] Inventariar datos locales y cobertura; pedir ubicación si faltan. No inventar resultados.
- [ ] Congelar hipótesis, baseline, costes, población, splits temporales y métricas antes de comparar.
- [ ] Replay causal: pivots solo tras confirmación, snapshots disponibles en decisión, horizontes completos.
- [ ] Deduplicar episodios; evitar leakage entre entrenamiento, selección y test final.
- [ ] Comparar guard ON/OFF y políticas de salida usando mismas señales/ejecución/costes.
- [ ] Medir net expectancy, drawdown, MAE/MFE, oportunidades descartadas y estabilidad por lado/símbolo.
- [ ] Separar replay de señales independientes de simulación de cartera con posiciones/reservas.
- [ ] Intervalos de incertidumbre por bloques temporales; holdout final no reutilizable.
- [ ] Sin edge estable: reportar NO_EDGE y conservar baseline. No promover a LIVE automáticamente.

```text
prerregistrar comparación
replay idéntico causal para baseline y candidato
excluir/revelar ventanas incompletas y datos inciertos (no convertir en cero)
comparar neto bajo mismos costes y restricciones de cartera
evaluar robustez fuera de muestra
emitir EVIDENCE_SUFFICIENT / INSUFFICIENT_DATA / NO_EDGE
```

## Entrega de cada fase

1. Implementar un bloque coherente y crear tests normales/adversariales sin ejecutarlos
   tras cada edición. No dejar los tests de seguridad para una futura sesión indefinida.
2. Al final del bloque: build, tests técnicos y regresión; no ocultar errores con skips,
   mocks permisivos o umbrales relajados. No requieren datos reales ni credenciales.
3. Actualizar checklist con evidencia, SHA y limitaciones; commits por responsabilidad.
4. Fetch antes de push; push normal a Micro. Si hay divergencia, preservar cambios y resolver
   conscientemente; no encadenar merge/rebase/force como receta automática.
5. Reportar por separado: implementado, probado, publicado, desplegado (este último NO autorizado).

Orden vigente: 0; ciclo crítico 1/2/3 con journal/reconciliación primero; 4; 5/6;
7/8; consolidación 9 y tooling 10. La numeración identifica fases, no exige terminar
un supervisor durable antes de programar el journal del que depende.
Los puntos parciales ya escritos no justifican saltar las pruebas de aceptación de su fase.
