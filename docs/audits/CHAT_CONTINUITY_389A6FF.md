# Prompt de continuidad integral — Aegis/Micro, revisión hasta 389a6ff

## Actualizacion posterior: d341225

R1-R4 descritos como abiertos mas abajo son evidencia historica de 389a6ff:
quedaron corregidos en el bloque publicado mediante `8306846` y el merge `d341225`.
No volver a presentarlos como pendientes. Leer primero
`SAFETY_RECONCILIATION_LEDGER_FIX.md` para publicacion verificada, pruebas del bloque
y seguimiento de identidad en reposicion y migracion legacy. Journal, integracion
y el resto de fases siguen pendientes; no hay aprobacion de despliegue.

Copia este documento completo en el nuevo chat o adjúntalo y pide que se lea íntegro.
Es un traspaso técnico y de decisiones. No es una certificación de seguridad ni rentabilidad.

## 1. Quién soy, qué construimos y qué espero

Soy Jasan. Construimos mi bot TypeScript de Binance Futures, Aegis/Phantom, con estrategias
Aegis Turbo, Momentum Ride y Micro Burst. Hay componentes de análisis/Python relacionados,
pero este trabajo se concentra en el repositorio TypeScript y su seguridad de ejecución.

Repositorio: https://github.com/jasanhdz/binance-futures-bot-ts
Rama de trabajo única: work/micro-burst-rider-v1-20260826.
Último código auditado en este traspaso: 389a6ff2cc6953b4628d3ab37a96a5054a1c5171.
Los commits de documentación posteriores no cambian ese baseline técnico.

Quiero terminar la implementación de las fases 0–10, crear tests útiles y publicar avances
que podamos evaluar. No quiero declaraciones de “diamante” o “fase completa” basadas sólo
en nombres de clases, una suite verde o el resumen de otro agente.

Háblame en español, claro, específico y al grano. Cuando te pase un reporte de otro agente,
verifica código y SHA, y distingue sus afirmaciones de tus comprobaciones. Si pido sólo
auditoría, no edites. Cuando pida implementar, trabaja y completa bloques coherentes;
no te limites a un plan ni pidas autorización repetida para tareas técnicas ya autorizadas.

## 2. Contexto operativo y límites

Trabajamos en entorno virtual. No tenemos seleccionados aquí datos reales de caja negra
ni dataset histórico para validación económica. Eso NO bloquea implementar lógica,
persistencia, adaptadores, tests sintéticos y simulación de fallos.

Preferencia de trabajo: implementar un bloque y crear tests, concentrando la ejecución
al final del bloque publicable. No ejecutar toda la suite después de cada edición.
Corregir los fallos de esa validación antes de declarar el bloque probado.

No arrancar bot, main.ts, PM2, LIVE, canary, soak, órdenes Binance ni procesos testnet.
No modificar credenciales, YAML LIVE, presupuesto, thresholds, apalancamiento o manifiestos
aprobados. Publicar código NO equivale a desplegar y no autoriza hacerlo.

La autorización de publicar avances existe para esta misma rama. No crear otra rama,
force push, reset --hard ni sobrescribir trabajo. Inspeccionar y preservar cambios locales.
No añadir a commits .env, secretos, node_modules, logs privados o datasets sensibles.
No eludir denegaciones de herramientas cambiando de mecanismo.

Mantener Micro con stop obligatorio y salida inteligente. NO reintroducir trailing ni
TP obligatorio de Aegis. Un veto de entrada no cierra una posición existente.
OFF/SHADOW/ENFORCE deben ser explícitos; desactivar entrada no elimina la protección.

El usuario menciona un guard que repone brackets. Existe supervisión interna versionada:
PositionProtectionService y su integración en TradingService. No negar su existencia.
Un posible proceso externo adicional y su cobertura real no se verificaron; no contar
garantías externas sin evidencia, ni duplicar lógica por desconocer el código existente.

No integrar otras ramas como feature/sui-sr-scout ni otros experimentos no solicitados.
No asumir que rutas scratch de conversaciones anteriores existen en el nuevo entorno.

## 3. Documentación y orden de lectura

Leer AGENTS.md y después:

1. docs/audits/CHAT_CONTINUITY_389A6FF.md — este documento; estado auditado más reciente.
2. docs/audits/SAFETY_PHASES_HANDOFF.md — plan 0–10, rutas, contratos y pseudocódigo.
3. docs/audits/CODEX_CONTINUE_SAFETY_PROMPT.md — instrucciones extensas de implementación.
4. docs/audits/SAFETY_HANDOFF_VALIDATION.md — distinguir resultados históricos/reportados.
5. docs/audits/SAFETY_PHASE0_BASELINE.md — baseline, matriz de autoridad y límites.

Las notas históricas de c5d4f60/f81a956 son contexto, no el HEAD actual.
Si documentos viejos dicen que sólo falta fase 9, esa afirmación quedó contradicha por
auditoría posterior. El código y reproducciones verificadas prevalecen sobre resúmenes.
Si ya hay commits posteriores a 389a6ff, revisarlos antes de repetir o dar por vigente un bug.

## 4. Origen del trabajo: detector de régimen

Empezamos auditando un bloqueo de SHORT en CHOP. El workflow tenía una lista fija de
regímenes bloqueados, separada de la política/configuración, y podía continuar si faltaba
regimeContext. Se buscó autoridad única, fail-closed conforme al modo y trazabilidad.

El baseline histórico 05b2339 incorporó correcciones del régimen:
- ADX Wilder compartido.
- Validación de OHLCV, orden, duplicados, gaps y timestamps.
- Contexto ausente tratado como UNKNOWN bajo ENFORCE.
- Eliminación del filtro SHORT hardcodeado del workflow; decisión por orchestrator/guard.
- Outcomes incompletos excluidos de estadísticas válidas.

No reintroducir esos bypasses ni una segunda política en el workflow.
Confidence sigue siendo heurística, no probabilidad calibrada.
Tests de código no demuestran que bloquear CHOP mejore el expectancy.

Después ampliamos el trabajo a seguridad transversal: protección, ejecución, concurrencia,
persistencia, contabilidad, datos, identidad/configuración, sizing y validación causal.

## 5. Mapa arquitectónico relevante

- src/main.ts: bootstrap y apagado; timeout exterior de 15 s.
- src/app/services/TradingService.ts: orquestación y mucha lógica aún concentrada.
- src/app/position/PositionProtectionService.ts: protección actual integrada, Micro stop,
  reconciliación de flat y helpers de lifecycle.
- src/app/position/PositionRecoveryService.ts: recuperación/adopción de posiciones.
- src/app/execution/SharedStrategyExecutionService.ts: ejecución compartida.
- src/app/ports/Exchange.ts: capacidades exchange, PositionInfo, TradeFill, órdenes.
- src/app/ports/StateStore.ts y src/infra/logging/FsStateStore.ts: estado y persistencia.
- src/app/risk/StrategyRiskSessionService.ts y src/core/risk/StrategyRiskLedger.ts:
  ledger/sesión que el runtime ya utiliza. No confundir con el nuevo RiskLedger.ts.
- src/strategies/micro-burst/: políticas de entrada/salida, contexto e identidad.
- src/strategies/aegis/domain/entry/: guards y orquestación de entrada.
- src/domain/services/regime-v2/: detector V2, hoy principalmente offline.
- src/tooling/: research/auditoría; estar aquí no concede autoridad de ejecución.

Nuevos módulos revisados, sin consumidores runtime encontrados en la última auditoría:
PositionSupervisor, AccountExposureSnapshot, ExecutionJournal/FileBackedExecutionJournal,
RiskLedger, SizingEngine y RegimeAuthority.
Las nuevas funciones validateDataQuality/freshness tampoco estaban conectadas a los
consumidores de decisión; Micro seguía usando validateCandleSequence.
El control de hash efectivo en MicroBurstIdentity sí cambió una ruta consumida.

Comprobar imports, instanciación, composición, scheduler y llamadas reales. No basta con
exports o tests unitarios. No enchufar módulos defectuosos para “completar integración”.

## 6. Historial de commits y qué podemos afirmar

| Commit | Trabajo / interpretación correcta |
| --- | --- |
| 05b2339 | Baseline histórico de régimen y datos; no certificación económica |
| be31c54 / ea8eacf | Estados de protección y validaciones de exposición/recuperación |
| e519a95 / 5c35190 | Reserva local y bloqueo de admisión al apagar; garantías inicialmente parciales |
| fbc7f19 | Lease por token/idempotencia, reintentos de lectura de stops y drenaje de tareas antes de flush |
| c5d4f60 | Persistencia de intento de stop Micro, cuarentena separada y reconciliación flat independiente |
| f81a956 | Traspaso documental para fases 0–10 en entorno virtual |
| 03ec3ae | Nuevo PositionSupervisor y funciones de frescura de velas |
| 47992bf | Nuevos AccountExposureSnapshot, ExecutionJournal, RiskLedger, SizingEngine |
| 12b1f35 | Comparación del hash efectivo de config y RegimeAuthority declarativo |
| ecfde4a | Utilidades safety-replay de episodios/métricas |
| 27656cd | Registro de validación del agente; fases sobreestimadas |
| fa90c27 | Primera ronda de correcciones; añadió FileBackedExecutionJournal, aún defectuoso |
| 389a6ff | Segunda ronda; mejoras parciales, cuatro fallos reproducidos siguen abiertos |

fa90c27 inicialmente no estaba en GitHub cuando se reportó; se verificó publicación después.
Ahora 389a6ff está publicado y fue descargado. No repetir que falta subir esos commits
sin una nueva comprobación. El árbol de trabajo de la auditoría quedó sin cambios de código.

## 7. Garantías previas que no se deben perder

En fbc7f19:
- SharedEntryReservation asigna token y release por lease. Un release antiguo no libera
  una reserva posterior del mismo símbolo ni de otro.
- La adquisición del lock ocurre sincrónicamente antes del primer await; hubo una regresión
  al posponerla a una microtarea y se corrigió preservando el test existente.
- TradingService registra tareas de entradas/gestión; bloquea nuevas entradas y espera
  tareas antes del flush normal. El timeout externo o un crash siguen requiriendo journal.

En c5d4f60:
- microStopSubmission registra attemptedAt, stopPrice y tradeId; se guarda antes del
  envío de reposición runtime y exige flush. Respuesta perdida no autoriza reenviar.
- Tras 30 s, con lecturas disponibles y sin confirmación, se solicita recuperación.
  El plazo es inyectable. Error de lectura sigue UNKNOWN, no “stop ausente”.
- microProtectionBlocked es diferente de marketOpenAmbiguous y microBurstPnlUnverified.
  Confirmar stop no resuelve ambigüedad de entrada ni contabilidad.
- MISSING se reconcilia antes de pedir indicadores: dos lecturas flat, cancelar sólo BOT,
  comprobar supervivientes y leer de nuevo posición; null explícito conforme al contrato.
- Tras cierre operativo confirmado: IDLE, identidad conservada y PnL pendiente.
  No inventar PnL, no actualizar rachas con mark price, no liberar admisión por conveniencia.
- Cuarentena consulta estados configurados/cargados, no todavía inventario universal.

Estas garantías estaban en el camino integrado. El nuevo PositionSupervisor duplicó parte
del código y perdió algunas. La meta es consolidar conservando/mejorando contratos,
no sustituir la implementación antigua por otra más débil.

## 8. Qué corrigió realmente 389a6ff

A. Añadió StopCheckResult: CONFIRMED / ABSENT / UNKNOWN.
   Todos los fallos de lectura ya pueden producir UNKNOWN. Persisten errores en secuencias mixtas.

B. Añadió preservePositionState a persistStatus y lo pasa en varios caminos.
   Falta en otros; no eliminó el cambio general RECOVERY_REQUIRED -> IDLE.

C. Añadió una consulta después de cancelar órdenes.
   Pero comprueba órdenes no BOT y sigue ignorando supervivientes BOT/errores.

D. Sizing revalida maxLoss después de redondear.
   La reproducción anterior con budget 0.006 y pérdida 0.01 ahora se rechaza.
   No extrapolar a garantía total: revisar precisión/step, valores no finitos, cantidad
   cero, tolerancia relativa 1.0001 y límites de margen/riesgo antes de integración.

E. Ledger distingue cierres atrasados para no incrementar tradesToday ni cambiar racha.
   Todavía añade su PnL a dailyPnl del día actual.

F. Frescura separa maxAgeMs del historial (24 h por defecto) y maxLastCandleAgeMs
   (30 min por defecto), propagado por validateDataQuality.
   Es una mejora de contrato. Debe fijarse un límite coherente con consumidor/timeframe;
   no asumir que 30 min es suficientemente fresco para Micro ni que está integrado.

## 9. Cuatro fallos ABIERTOS reproducidos en 389a6ff

Las reproducciones se ejecutaron cargando el código del commit mediante git show y
transpilándolo en memoria, con exchange simulado. No fueron órdenes reales, cambios
del repositorio ni una nueva ejecución de la suite completa.

### R1 — Reaparecimiento todavía termina en IDLE (alta prioridad)

Archivo: src/app/position/PositionSupervisor.ts.
Escenario: estado LONG_RIDE; primera lectura null; durante reconcileFlat reaparece una
posición LONG real. Los caminos POSITION_REAPPEARED / POST_CLEANUP no pasan el flag
preservePositionState; persistStatus todavía pone IDLE por defecto.

Resultado reproducido:
    status = RECOVERY_REQUIRED
    mode = IDLE

Corrección: persistStatus NO debe modificar mode a IDLE. Solamente un método específico
de cierre confirmado puede hacerlo. Conservar lado, dueño, cantidad e identidad con
posición abierta/desconocida. No reparar agregando otro flag frágil a unos cuantos callers.

Tests: reaparece antes/después de limpieza; propietario desconocido; stop ausente;
cierre fallido. En todos, ausencia de confirmación flat impide IDLE.

### R2 — Error seguido de lista vacía autoriza reposición (alta prioridad)

Archivo: mismo supervisor, hasConfirmedStop.
lastError se pone true al fallar una consulta y se resetea false si otra devuelve vacío.
El comentario promete conservar cualquier error, pero el código conserva sólo el último.

Escenario: dos intentos; primero timeout, segundo []; posición abierta, stop recordado,
store con flush válido. Resultado: un envío de stop y CONFIRMATION_PENDING.

Corrección contractual conservadora: mantener sawReadError durante toda la ventana.
Evidencia positiva de un stop válido -> CONFIRMED; sin evidencia positiva y con cualquier
error -> UNKNOWN; ABSENT sólo si las observaciones requeridas son válidas y vacías.
UNKNOWN no autoriza un nuevo envío/cierre por sí solo. Validar límites de reintentos.

Tests: error→vacío, vacío→error, error→stop válido, todos errores y ausencia consistente.
Spies deben verificar placeStopClose/closeSideMarketSafe no llamados bajo incertidumbre.

### R3 — BOT superviviente no impide finalizar limpieza (alta prioridad)

Archivo: mismo supervisor, reconcileFlat y camino de emergencia.
La lista post-cancel se filtra por owner !== BOT. Así ignora exactamente la orden BOT
cuya cancelación falló; excepciones al consultar también se ignoran.

Escenario: posición flat; orden BOT visible antes y después; cancelOrderById falla.
Resultado: MISSING y mode IDLE como si hubiera terminado la recuperación.

Corrección: reconsultar, exigir ausencia de órdenes propias supervivientes y mantener
cleanup/recovery pendiente si no se puede confirmar. No cancelar órdenes ajenas.
Separar estado físico flat de recuperación completamente terminada para no habilitar
entradas mientras queden órdenes peligrosas. Puede modelarse flat+cleanup pending,
pero nunca declararlo “limpio/recuperado” ni borrar cuarentena.

Revisar además el cierre de emergencia: conserva una salida temprana con la primera
observación flat; el comentario “dos observaciones” no hace que el código las exija.
Su camino de limpieza debe reutilizar el mismo contrato estricto y no best-effort.
Comprobar persistencia/identidad antes de mutar; sin store no afirmar cierre durable.

Tests: cancelación falla y orden persiste; cancelación reconocida pero visible;
lectura post-cancel falla; orden ajena preservada; posición reaparece; una sola
observación flat seguida de posición real no completa el cierre.

### R4 — PnL atrasado continúa contaminando el día actual (alta prioridad)

Archivo: src/core/risk/RiskLedger.ts.
Escenario:
    estado actual: 2026-09-05, dailyPnl = 10, tradesToday = 2
    cierre verificado del 2026-09-04: netPnl = -25
    resultado: dailyPnl = -15; tradesToday = 2

No debe confundirse saldo de cuenta con resultado económico atribuido al día.
Corrección: buckets/ledger por fecha económica, aplicación idempotente al día correcto.
Definir rachas cronológicas y manejo de eventos tardíos, sin descartar silenciosamente
la pérdida ni cargarla al día de recepción. Persistir evidencia/resultado y claves.

Tests: cierre tardío anterior a medianoche, duplicado tardío, reinicio, timestamps/NaN
inválidos, cierre corregido con identidad estable y reconstrucción cronológica.

## 10. Otros pendientes críticos reconocidos y NO resueltos

### Journal (fase 3)

src/core/risk/ExecutionJournal.ts:
- FileBackedExecutionJournal escribe pero no carga archivo al construir.
- Tras reinicio read devuelve vacío/isSubmitted false; el siguiente append sobrescribe
  el historial por el contenido nuevo en memoria.
- flush usa writeFileSync del array completo: no es append JSONL, no hay escritura
  atómica ni fsync explícito; el comentario sobre durabilidad es excesivo.
- La máquina de estados es por símbolo. Tras CLOSED, PREPARED de una segunda operación
  de ese símbolo es inválido. Debe ser por intención/trade, incluyendo positionSide.
- Estado en memoria se modifica antes de confirmar escritura: diseñar fallo/recovery.
- Hay que conservar intentos PREPARED cuyo envío pudo ocurrir sin acuse; isSubmitted false
  por sí solo no autoriza retransmitir una intención potencialmente ejecutada.

Reproducción previa fa90c27, archivo sin corrección en 389a6ff:
guardar 2 eventos -> nueva instancia recupera 0 -> siguiente append deja 1 evento nuevo.
Otro trade tras CLOSED -> Invalid transition CLOSED -> PREPARED for ETHUSDT.

Programar carga/validación, versionado, identidad por intención, persistencia durable,
escritor único, corrupción/truncado, recuperación repetible y contrato de fallo de disco.
Tests con filesystem temporal y reinicios reales de instancias, no sólo spy writeFileSync.

### Integración y exposición (fases 1/2/3/4/8/9)

Módulos nuevos sin consumidores runtime encontrados; validar nuevamente si cambió HEAD.
Un snapshot de cuenta debe provenir del adaptador completo y representar órdenes y
reservas, no sólo símbolos LIVE configurados.

AccountExposureSnapshot mejoró availableBalance, pero conserva fallback a wallet+PnL
cuando falta; no asumir ese fallback = margen disponible certificado. Sigue mezclando
notional reservado con margen y necesita reglas de unidades, frescura y completitud.
Revisar cantidades negativas, leverage, duplicados hedge/BOTH, pendientes y totales.

Reservar riesgo durante intenciones inciertas. Mantener exclusión por cuenta/operación,
no sólo booleanos ni token local. Dos hosts necesitan garantía de escritor/fencing
adecuada; un TTL local no basta. No soltar riesgo porque venció un timeout.

La contabilidad runtime antigua aún necesita fills atribuibles/paginados, comisiones,
funding según contrato, moneda común, cantidades completas y deduplicación.
RiskLedger nuevo no realiza por sí solo esa reconciliación.

### Régimen (fase 7)

RegimeContextGuardAdapter sigue usando retorno entre cierres como emaFastSlope, con
emaMid/emaSlow undefined y ventanas fijas en partes del cálculo. RegimeAuthority es
declarativo, no corrige indicadores ni integra autoridad.

Conservar ADX Wilder, UNKNOWN conforme al modo, razones raíz y autoridad única.
Legacy clasifica runtime; V2 es offline. No activar V2 o vetos nuevos sin contrato,
evidencia y aprobación de política. Confidence no es probabilidad de éxito.

### Replay (fase 10)

src/tooling/safety-replay.ts agrega episodios resueltos; no es replay causal completo.
validateTemporalSplits sólo compara startedAtMs < closedAtMs, no demuestra ausencia
de lookahead. Faltan loaders/CLI integrados, replay de decisiones, misma población
ON/OFF, costes verificables, splits/holdout, restricciones de cartera e incertidumbre.
Incompletos ya devuelven INSUFFICIENT_DATA; eso no completa la fase.

Sin dataset real: terminar tooling y tests sintéticos; devolver PENDING_REAL_DATA/
INSUFFICIENT_DATA. No fabricar métricas, afirmar rentabilidad ni NO_EDGE sin evaluación.

## 11. Estado real por fase y prioridades

| Fase | Estado defendible | Pendiente principal |
| --- | --- | --- |
| 0 | Avanzada, documentación requiere disciplina | Baseline reproducible y evidencia externa separada |
| 1 | Parcial; supervisor nuevo no integrado y con R1–R3 | Contrato común seguro, inventario y recovery |
| 2 | Parcial; snapshot aislado | Unidades, adapter cuenta completa, reservas y escritor |
| 3 | Parcial; journal no apto para reinicios | Persistencia y recovery por operación |
| 4 | Parcial; R4 y reconciliación de fills pendiente | PnL correcto por fecha y ledger durable |
| 5 | Parcial; mejoras puras de frescura | Límites por consumidor y validación antes de indicadores |
| 6 | Parcial; hash efectivo ya se compara | Identidad/config aprobada no circular y provenance completa |
| 7 | Parcial; contrato declarativo | Indicadores correctos y autoridad runtime explícita |
| 8 | Parcial; motor puro con mejora de maxLoss | Validación integral y cableado bajo presupuesto autorizado |
| 9 | Pendiente | Extracción con paridad, después de estabilizar contratos |
| 10 | Parcial; métricas sintéticas | Replay causal completo; evidencia económica pendiente |

Orden inmediato:
1. R1–R3 del supervisor y R4 del ledger, con regresiones exactas.
2. Journal durable por operación; también desbloquea recovery e integración segura.
3. Exposición/reservas e integración vertical del camino admisión→ejecución→protección→cierre.
4. Contabilidad integral y recuperación de cuarentenas por evidencia.
5. Completar datos, identidad, régimen y sizing conforme a dependencias.
6. Consolidar extracción arquitectónica de fase 9 sin alterar decisiones.
7. Completar tooling fase 10, dejando evaluación real pendiente.

No es “sólo falta fase 9”. Completar una fase exige implementación funcional, consumidores,
tests adecuados y límites documentados; los componentes experimentales pueden estar
implementados con activación separada, sin modificar silenciosamente LIVE.

## 12. Evidencia de tests: no confundir reportes con ejecuciones propias

- c5d4f60: la sesión anterior ejecutó build y 1.590 + 46 = 1.636 pruebas.
- El agente posterior reportó 1.765 en un resumen, mientras el documento de 27656cd
  decía 1.753; hubo discrepancia, no se certificó el total en la auditoría.
- fa90c27: el usuario reportó build PASS, 183 archivos y 1.774 tests.
- 389a6ff: el usuario reportó build PASS, 182 archivos y 1.728 tests.
  Es compatible con grupo principal: 1.728 + 46 ConfigLoader = 1.774; comprobar ejecución
  del segundo grupo antes de afirmarlo como total propio.
- Las auditorías de 27656cd/fa90c27/389a6ff usaron lectura y reproducciones sintéticas
  dirigidas; NO repitieron la suite completa ni modificaron código de estrategia.
- Este traspaso es documental. No presenta esos números como tests ejecutados otra vez.
- Una suite verde no invalida una reproducción adversarial de un caso no cubierto.

Runner existente:
    npm run test:safety

Equivale a:
    npm run build
    REGIME_CONFIG=regime_config.live.yaml npx vitest run --silent --exclude src/infra/config/ConfigLoader.aegis-symbols.test.ts
    env -u REGIME_CONFIG npx vitest run src/infra/config/ConfigLoader.aegis-symbols.test.ts --silent
    git diff --check

Separación necesaria por precedencia de REGIME_CONFIG y fixtures de ConfigLoader.
No cambiar producción para resolver el entorno de pruebas.
Usar lockfile; no arrancar bot para comprobar código.
Tests de seguridad deben observar estado, disco, órdenes simuladas y prohibiciones,
no sólo retornos, nombres de clases o logs. Incluir casos mixtos, reinicio y concurrencia.
No debilitar tests existentes ni convertir los resultados defectuosos en expectativas.

## 13. Contratos/pseudocódigo para orientar la solución

    comprobar_stop:
        hubo_error = false
        por cada intento permitido:
            consultar órdenes
            si stop válido cubre posición: devolver CONFIRMED
            si error: hubo_error = true
        devolver UNKNOWN si hubo_error; si no, ABSENT

    actualizar_estado_de_seguridad:
        persistir incertidumbre/recovery sin cambiar mode de posición
        no interpretar RECOVERY_REQUIRED como flat
        sólo cerrar_estado_local después del contrato de cierre confirmado

    reconciliar_cierre:
        confirmar flat según contrato, sin convertir errores/undefined en null
        listar y cancelar únicamente órdenes propias
        reconsultar y exigir ausencia de BOT supervivientes para cleanup completo
        si error/supervivientes: mantener cleanup/recovery pendiente y admisión bloqueada
        revalidar posición; persistir cierre operativo y ACCOUNTING_PENDING
        nunca borrar ambigüedad de entrada ni estimar PnL como verificado

    journal:
        cargar, validar y reconstruir estado por intención al arrancar
        persistir intención antes del envío; identidad estable
        confirmar escritura durable antes de afirmar que está persistido
        resultado incierto -> reconciliar, no reenviar a ciegas
        permitir operaciones sucesivas y hedge sin mezclar máquinas de estado

    ledger:
        validar evidencia, números, identidad y fecha económica
        deduplicar y aplicar al bucket correcto
        reconstruir rachas por orden económico definido
        persistir claves/resultados juntos o con recuperación idempotente
        liberar sólo cuarentenas cuya causa esté resuelta

    publicación:
        terminar bloque -> tests técnicos -> revisar diff -> commit
        fetch y push normal en micro -> verificar SHA remoto
        actualizar docs con pruebas propias/reportadas y pendientes

## 14. Cómo arrancar en el nuevo chat

1. Confirma repositorio/rama/HEAD usando la app GitHub o el checkout autorizado.
   Si falta el commit, verifica publicación; no audites sólo el texto del reporte.
2. Preserva cambios locales antes de integrar, usando fast-forward si corresponde.
3. Lee este documento y las instrucciones del repo. Revisa commits posteriores si existen.
4. Comprueba si R1–R4 siguen presentes; no recomiences la arquitectura desde cero.
5. Si el usuario pide implementar, corrige primero esos casos y el journal, prepara tests,
   valida al final del bloque, publica y sigue con tareas seguras ya autorizadas.
   Si pasa un nuevo reporte para auditar, mantén modo lectura y da hallazgos específicos.
6. Mantén un TODO vivo por fase con IMPLEMENTACION, INTEGRACION, TESTS,
   VALIDACION_REAL, COMMIT y SIGUIENTE_PENDIENTE.
7. No pidas datos históricos para poder programar un journal ni apruebes presupuesto
   LIVE para evitar una pregunta. Aísla lo que necesita decisión del propietario.
8. En cada entrega explica qué quedó corregido, qué reprodujiste, qué NO ejecutaste,
   SHA remoto comprobado y siguiente tarea. No anunciar trabajo en segundo plano inexistente.

Objetivo final: bot con contratos coherentes de seguridad, recovery y contabilidad,
módulos realmente integrados, tests adversariales y herramientas de evaluación completas.
La evidencia económica, presupuesto/activación y despliegue se autorizan y verifican aparte.
