# Evidencia causal y replay pareado — alcance de la implementación

## Dos preguntas separadas

La candidata V1 sigue siendo un subconjunto de CURRENT: no evalúa si el momentum
original o el flujo de cinco minutos descartan oportunidades útiles.

`summarizePairedReplay` separa:

- **Selección descriptiva:** resultados de CURRENT para episodios posteriormente
  aceptados frente a rechazados por la candidata. Ambos grupos usan la entrada
  CURRENT. Condicionar a una confirmación futura no es una regla ejecutable en T0.
- **Resultado operable modelado:** cada variante tiene señal, demora, entrada a
  cantidad, stop, extremos, tiempo en posición y estado del motor de salida propios.
  La diferencia pareada solo se calcula donde ambas tienen resultado CLOSED.
  Se muestran unknown, unfilled y falta de registro: no se convierten en PnL cero.
- El reporte distingue rechazo del selector, espera, datos requeridos desconocidos,
  ejecución no registrada, UNFILLED y terminales modelados. Cada resultado/audit debe
  volver a un frame verificado, contrato, decisión y lista de intervalos cubierta.

Las medias de casos completos son descriptivas y pueden tener sesgo de selección;
no son una estimación suficiente de esperanza positiva ni una prueba fuera de muestra.

## Adaptador

`MicroBurstCausalArchive.ts`:

- Lee gzip NDJSON, verifica SHA-256, record_count, terminación e identidad de envelope.
- Filtra eventTime por reloj de exchange y receivedAtMs por reloj local de decisión.
- Requiere un manifiesto explícito de cobertura de sesión/gaps; no infiere cobertura
  del primer/último trade. Requiere un trade anterior a la ventana como ancla y IDs
  contiguos visibles; tolera duplicados idénticos, rechaza conflictos.
- Reconstruye depth desde checkpoint con secuencia pu/U/u y recepción causal.
- Mantiene límites de profundidad del checkpoint: no inventa liquidez fuera de esos
  límites. Si el mejor nivel queda desconocido, no hay libro ejecutable certificado.
- VWAP consume cantidad; profundidad insuficiente devuelve null.

`MicroBurstCaptureSession.ts` abre sesiones cerradas con hashes consistentes de
productor, config, decisiones, segmentos e índice SQLite. Esto prueba integridad de
los bytes archivados y coherencia con el manifest; no es una firma del exchange ni
demuestra que el productor no perdió datos antes de escribirlos. `health.json` y
`completion.json` se comprueban por valores/relojes, pero sus propios hashes no forman
parte del manifest V1; el manifest tampoco está firmado externamente.

## Frontera de evidencia del replay pareado

`buildVerifiedReplayFrame()` en `MicroBurstVerifiedReplayFrame.ts` es el único
constructor de frames aceptados por `replayPairedExecutions()`. Requiere una sesión,
decisión y observación ya verificadas en el proceso. Decodifica los relojes y el libro
esperado desde el input original; el llamador no suministra `decisionId`, `asOf`, libro,
`coverageVerified` ni un límite de frescura. El frame queda ligado a hash de sesión,
artefacto, contenido de decisión, símbolo y contrato de evidencia. Los lectores usados
por esta frontera reciben la decisión original y derivan identidad y relojes de ella.
Los intervalos sólo se verifican entre decisiones verificadas consecutivas del mismo
símbolo; se rechazan decisiones omitidas dentro del tramo.

El contrato `MICRO_PAIRED_REPLAY_EVIDENCE_V1` fija la frescura máxima del libro en el
límite existente de CURRENT (30 s) y la separación de observaciones en el límite
prerregistrado de la candidata (2 s). También fija el hash del
`PULLBACK_EXPERIMENT_V1`; el replay toma la política de salida de los inputs registrados
y rechaza mezclar configuraciones en una misma comparación. Cada frame declara una de
estas situaciones:

- `VERIFIED_POINT`: libro causal para esa decisión; por sí solo no acredita la
  trayectoria posterior ni permite un fill después de una demora.
- `VERIFIED_INTERVAL`: dos decisiones registradas consecutivas, reloj exchange y
  recepción local separados, checkpoint persistido y disponible antes del inicio,
  libro fuente coincidente y deltas depth encadenados entre los dos instantes.
- `UNKNOWN`: checkpoint ausente/antiguo, gaps, timestamps incompatibles, secuencia
  `U/u/pu` rota, ausencia de updates observados o cualquier evidencia insuficiente.

El intervalo se comprueba leyendo los archivos cuyos rangos de recepción, calculados
al verificar cada byte, se solapan con el tramo; las fechas mínimas/máximas sólo
seleccionan archivos, no certifican continuidad. Sus envelopes se contrastan con el
índice SQLite. Se verifican orden causal, duplicados, solapamientos, `U/u/pu` y los
límites de profundidad conocidos. Un checkpoint posterior a un hueco puede servir como
punto nuevo para intervalos futuros, pero nunca reconstruye la trayectoria anterior.
Sin updates depth observados se declara unknown: el archivo no permite distinguir
mercado quieto de silencio del feed. Los trades se verifican en las ventanas requeridas
por la política y cubren el intervalo real entre decisiones; una ventana final de 60 s
no sustituye una trayectoria más larga. El builder rechaza decisiones intermedias
omitidas; CURRENT y PULLBACK conservan señales, demoras, sizing y estado de salida
independientes.

La marca en proceso no es un sandbox frente a código arbitrario y las sumas hash no
autentican al exchange. La continuidad probada es la continuidad de updates que el
archivo conserva y cuya secuencia se puede verificar; no la completitud absoluta de la
captura. Un corte de energía no está modelado por las pruebas de terminación de proceso.
El reader de funding valida schema, orden e integridad hash del contenido ligado a la
sesión; su campo `source` es autodeclarado, no autentica una respuesta de Binance.

La cobertura declarada debe proceder de auditoría de sesión (inicio, fin, gaps,
overflows), no de un booleano elegido por el usuario. El lector verifica integridad,
no puede demostrar por sí solo que se archivaron todos los segmentos de una sesión.
Los checkpoints históricos guardan observedAtMs; antes de convertirlo a receivedAtMs
hay que comprobar su semántica en el productor, nunca sustituirlo por hora del archivo.

## Modelo de ejecución

`MicroBurstPairedExecutionReplay.ts` consume sólo `VerifiedReplayFrame` producidos por
la frontera anterior. Un objeto fabricado o copiado pierde la marca débil en proceso y
es rechazado. Los fills siguen siendo modelos por VWAP, no fills reales.

- Una ejecución por episodio y variante; una posición concurrente por variante.
- Mismo presupuesto monetario al stop, máximo notional, step y costes para ambas.
- Cada entrada espera su demora y usa el libro del primer frame elegible posterior.
- Revalida identidad, geometría y recorrido neto al precio nuevo. Cambio de
  stop/target durante la demora invalida el intento en lugar de heredar una geometría
  anterior favorable. No reutiliza el precio inicial de CURRENT para la candidata.
- Sizing por pérdida al stop estresado y comisiones; VWAP incluye spread. El
  deslizamiento adverso es un supuesto explícito adicional. El coste neto de admisión
  usa como mínimo las comisiones modeladas y deslizamiento residual.
- Usa MicroBurstExitEngine con estado independiente y tiempos desde cada entrada.
- Salida pendiente respeta demora y se ejecuta sobre el nuevo libro, no el de decisión.
- Huecos, profundidad de salida insuficiente y final incompleto producen UNKNOWN. Una
  posición abierta conserva sus fills modelados anteriores, pero su resultado total
  no recibe PnL terminal certificado después de perder cobertura.
- Funding cero requiere evidencia explícita de ausencia de funding ligada a la misma
  sesión; una sesión distinta no se acepta.

**Límites:** asume cobertura inmediata del stop y aplicación inmediata de MOVE_STOP;
no replica demoras/fallos de protección del exchange, ni valida liquidación/margen ni
exposición conjunta entre símbolos. No certifica paridad completa LIVE. La cobertura
entre frames debe verificar que no se omitió un toque de stop o evidencia de salida;
un muestreo cada segundo no basta por sí solo para demostrarlo.

El cambio de sizing aquí es un presupuesto de investigación común a ambas variantes,
no una reproducción del MARGIN_FRACTION LIVE ni una modificación del bot.

## Validaciones realizadas

Pruebas deterministas con sesiones sintéticas: segmentos parciales, hueco `pu` entre
segmentos, duplicados exactos/conflictivos, checkpoint de reconexión, libro antiguo,
clock/decision identity, no updates observados y frames pareados válidos. La integración
sesión verificada → candidato → `VerifiedReplayFrame` → replay es sintética. La decisión
CURRENT y checkpoints son fixtures, no reconstrucción real del contexto completo.

Las pruebas también verifican funding ligado a la misma sesión y que un rechazo
PULLBACK se informa como rechazo, distinto de espera, datos desconocidos o una ejecución
sin registro. No constituyen un certificado de un episodio real. El `MicroBurstEpisodeCapture`
persiste un journal encadenado; un lifecycle incompleto del episodio sigue siendo
distinto de cierre económico de una posición.

También prueba que una oportunidad consumida durante la espera queda UNFILLED,
que un gap invalida resultados, que la política Micro puede cerrar sin tocar stop,
y que las observaciones repetidas no multiplican episodios en el reporte.

La lectura read-only histórica de los primeros cuatro segmentos de cada símbolo en
`data/micro-burst/shadow-20261001/research.sqlite`:

- SOL: 2 752 registros, trades y depth, integridad válida.
- AVAX: 2 101 registros, trades y depth, integridad válida.

**Esto no es un backtest económico real completo.** No se afirma que este subconjunto
anterior a la frontera corregida pase el builder nuevo. Falta una captura V2 que incluya
un episodio real y la trayectoria causal completa de las dos variantes. No cambiar los
2 s ni interpolar snapshots para eludir ese requisito.

No se cambió LIVE, no se reinició PM2 ni se sustituyó dist. La candidata continúa
aislada bajo tooling. La siguiente certificación debe ser un episodio real completo
con todos esos enlaces, antes de publicar una comparación de rentabilidad.

Verificación offline del árbol de código (sin recorrer los artefactos congelados):

```bash
DOTENV_CONFIG_PATH=/dev/null ./node_modules/.bin/tsc --noEmit -p tsconfig.json
DOTENV_CONFIG_PATH=/dev/null ./node_modules/.bin/vitest run \
  --config src/testing/OfflineVitest.config.ts --exclude 'data/**' \
  --maxWorkers=1 --no-file-parallelism
```

La suite omite `data/**` deliberadamente: los directorios de captura son evidencia,
no archivos de prueba del proyecto. La ejecución sintética no certifica el contenido
de `collector-20261002-v2` ni la integridad económica de ningún episodio real.

## Recorrido pareado offline conectado

`MicroBurstPairedReplayCli.ts` y `MicroBurstPairedReplayOrchestrator.ts` conectan ahora
la sesión cerrada, las decisiones verificadas, el selector con persistencia, los frames
verificados, el replay independiente y el reporte. No importan adapters de Exchange,
TradingService ni código de runtime. La sesión fuente se abre read-only; los dos outputs
se escriben fuera de todo el árbol del colector, con creación exclusiva para no pisar una
ejecución anterior.

La entrada es un request JSON V1 y requiere rango local explícito de recepción, símbolo,
criterio de episodio opcional, horizonte de selección explícito o `null`, contrato de
evidencia y supuestos económicos:

```json
{
  "schema": "MICRO_PAIRED_ARCHIVE_REPLAY_REQUEST_V1",
  "captureRoot": "/data/local/compatible-collector",
  "outputDir": "/tmp/micro-paired-results/run-001",
  "symbol": "SOLUSDT",
  "range": {
    "fromReceivedAtMs": 1790982000000,
    "throughReceivedAtMs": 1790982600000
  },
  "selection": {
    "episodeId": "MB-EP-example-or-omit-this-property",
    "selectionHorizonMs": null
  },
  "experiment": {
    "schema": "MICRO_PAIRED_REPLAY_EVIDENCE_V1",
    "sha256": "6fd9cab7fb47bfabc2706c9e32b574fcacc9a5503b2428d436f2a29300aadb67"
  },
  "execution": {
    "riskBudgetUsdt": 1,
    "maxNotionalUsdt": 100,
    "quantityStep": 0.001,
    "minNotionalUsdt": 1,
    "feeBpsPerSide": 5,
    "adverseSlippageBps": 1,
    "entryDelayMs": 1000,
    "exitDelayMs": 1000
  }
}
```

Quita `episodeId` para procesar todos los episodios elegibles del rango. El request admite
hasta 10 minutos y 20.000 decisiones; los segmentos comprimidos se verifican en streaming,
y sólo se retienen decisiones del rango/símbolo y sus frames. El índice autenticado de
decisiones conserva metadatos de identidad para rechazar duplicados y decisiones omitidas.
El rango se aplica a `evaluatedAtReceivedMs` (disponibilidad local de la decisión); el frame
conserva por separado `observedAtMs` y reloj exchange del input. La demora de orden empieza
en la disponibilidad de la decisión/confirmación, no en un timestamp de contexto anterior.
`selectionHorizonMs` es una regla explícita de investigación, contada desde la disponibilidad
de la primera señal CURRENT del episodio. Con `null`, un `WAIT` al final permanece incompleto;
nunca se reetiqueta como rechazo.

Comando:

```bash
DOTENV_CONFIG_PATH=/dev/null npm run micro-burst:paired-replay -- /tmp/paired-request.json
```

También se puede invocar `npx ts-node
src/tooling/micro-burst/MicroBurstPairedReplayCli.ts /tmp/paired-request.json`. El
contrato admitido es `MICRO_BURST_CAPTURE_SESSION_V1` más artefacto productor
`MICRO_COLLECTOR_FROZEN_V2`; una captura/manifiesto V1 no se convierte ni se admite por
compatibilidad aproximada. Rechaza manifiestos incompatibles, límites no finitos, rangos
fuera de sesión, exceso de decisiones, contrato alterado y salida dentro del colector.

Produce `report.json` (hashes, revisiones/configs, decisiones/observaciones, rechazos,
trazas de ejecución, terminales y denominadores) y `summary.md`. Estados terminales
distinguen `REJECTED_BY_SELECTOR`, `SELECTION_WINDOW_EXPIRED_WITHOUT_QUALIFICATION`,
`WAITING_AT_END_OF_CAPTURE`, `UNFILLED`, `MODELLED_CLOSED`,
`ACCEPTED_WITHOUT_MODELLED_EXECUTION`, `UNKNOWN_TOTAL_AFTER_MODELLED_ENTRY`,
`SESSION_ENDED_WITH_FOLLOW_UP_PENDING`, `UNKNOWN_OR_INCOMPLETE`, `TECHNICAL_ERROR` e
incompletitud tras calificación. Cada terminal incluye el motivo; cuando no hay episodios,
el comando termina con `NO_ELIGIBLE_EPISODES`, terminales vacíos y medias `null`, no cero.
Huecos conservan cualquier entrada ya modelada, pero no conceden PnL de cierre. Los resultados cerrados para medias y diferencias son sólo el subconjunto
`MODELLED_CLOSED`; el reporte da denominadores y lista exclusiones para cada media y el
delta pareado.
El `sourceTreeSha256` del ejecutor incluye el commit y cambios locales de las dependencias
Micro relevantes; el reporte también fija `sourceWorktreeDirty`, versión Node, hash del
contrato, configuración de salida por decisión, supuestos de coste y sizing.

CURRENT reejecuta la entrada exacta almacenada bajo la revisión de evaluador admitida,
exige concordancia campo por campo con la decisión original y registra revisión/config.
Una discrepancia es `TECHNICAL_ERROR` y bloquea todo el episodio en ambas variantes.
El reporte lo denomina reevaluación de inputs capturados, no ejecución exacta del binario
histórico. PULLBACK recorre las observaciones realmente guardadas, usa el estado de
persistencia existente y reinicia con evidencia insuficiente; no interpola decisiones.
Los IDs de episodio del baseline deduplican repeticiones; hay como máximo una operación
por episodio y variante.

La salida del motor de cierre sólo observa los frames de decisiones guardados, aunque los
intervalos depth entre ellos sean verificados. No se afirma que se hayan reconstruido el
contexto del motor ni todos los eventos de disparo de stop/salida entre frames. Un cierre
es un cierre **modelado sobre frames observados**, no una reproducción fiel del stop
exchange, latencia/cola, impacto, margen LIVE o protección. Sizing es el presupuesto común
de riesgo del experimento, no sizing LIVE por margen.

### Recorrido sintético reproducible

Las pruebas de CLI crean una sesión mínima mediante los fixtures de captura verificados,
la abren por el mismo `openVerifiedCaptureSession` público y llaman
`runPairedReplayRequestFile`, que es la entrada que usa la CLI. CURRENT y PULLBACK tienen
fills distintos y pueden cerrarse bajo un `exitMaxHoldMs` explícito e idéntico en el replay
capturado; otras fixtures cubren rechazo, WAIT con/sin horizonte, oportunidad desaparecida,
depth insuficiente, discontinuidad, hueco con posición, fin temprano, cero episodios,
manifiesto incompatible, discrepancia del evaluador, filtro por episodio y determinismo.
La decisión fixture se inyecta con `evaluateMicroBurstReactionEntry` en el generador de
pruebas; no se presenta como señal de mercado. El código de producción reutiliza el
evaluador autorizado y exige que reproduzca la decisión almacenada.

Reproducir esa fixture:

```bash
TMPDIR=/tmp/opencode DOTENV_CONFIG_PATH=/dev/null ./node_modules/.bin/vitest run \
  --config src/testing/OfflineVitest.config.ts --exclude 'data/**' \
  src/tooling/micro-burst/MicroBurstPairedReplayCli.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

Ejemplo del reporte de fixture: `COMPLETED`, 8 decisiones y 1 episodio único; CURRENT
entra en `BASE+1000 ms`, PULLBACK entra tras la confirmación en `BASE+4000 ms`, y ambos
cierran bajo el horizonte corto de salida fijado en esa fixture. La comparación etiqueta
1 par cerrado como VWAP modelado. Eso sólo demuestra el recorrido de software con inputs
sintéticos.

### Comprobación explícita del defecto original

| Requisito                                                          | Implementación                                                                                                                                                        | Regresión que lo demuestra                                                                                                                                                             | Resultado                                                                            |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Cobertura de todo el intervalo, no mera intersección de segmentos  | `verifyVerifiedDecisionInterval()` reconstituye desde checkpoint preintervalo y exige libro inicial/final, actualizaciones causales, trades y decisiones consecutivas | `rejects a segment that overlaps an interval when no checkpoint proves its start`; `rejects a pu discontinuity hidden by adjacent segment time ranges`                                 | Pasa; un segmento que sólo solapa no basta y un `pu` roto devuelve `UNKNOWN`         |
| Puente checkpoint → updates con continuidad USD-M                  | `replayCausalDepth()` encadena `U/u/pu`, ordena por recepción causal y contrasta ambos estados                                                                        | `accepts exact duplicates and overlapping USD-M ranges while rejecting conflicting duplicates`; `uses a reconnect checkpoint only as a new point and never fills across the prior gap` | Pasa; duplicado conflictivo/hueco no genera estado ejecutable                        |
| Checkpoint posterior no repara el tramo anterior                   | El intervalo exige un checkpoint disponible antes del inicio y verifica entre decisiones; un nuevo checkpoint sólo habilita un frame punto                            | `uses a reconnect checkpoint only as a new point and never fills across the prior gap`                                                                                                 | Pasa; el primer tramo queda unknown y sólo el posterior puede verificarse            |
| Libro ligado a símbolo, decisión, contenido y manifiesto de sesión | `readVerifiedExecutionBookForDecision()`, `assertVerifiedDecisionInSession()` y `buildVerifiedReplayFrame()` comparan IDs, hashes, símbolo, clocks y sesión           | `does not let a frame use an observation from a different verified decision`; `does not let a verified decision or frame cross capture sessions`                                       | Pasa; rechazos antes de producir frame aceptable                                     |
| Event time, receive time y disponibilidad del checkpoint           | `replayCausalDepth()` limita ambos clocks; query de checkpoint requiere `created_at_ms <= decision.observedAtMs`                                                      | `does not consume depth events outside either the exchange or local receive cutoff`; `rejects a depth checkpoint that was persisted after the decision became available`               | Pasa; eventos fuera de cualquiera de los clocks y checkpoints futuros quedan unknown |
| Disponibilidad real de decisión frente al timestamp del contexto   | El frame registra `decisionAvailableAtMs`; señales y demoras comienzan allí, manteniendo `atMs`/book ligado al contexto recibido                                      | `starts delays from decision availability, not an earlier context observation timestamp`; `preserves distinct exchange-event and local-receive clocks in a verified point frame`       | Pasa; una decisión disponible 500 ms después no puede ejecutar como si ya existiera  |
| Frescura fija y no ampliable por frame                             | `MICRO_PAIRED_REPLAY_EVIDENCE_V1` fija 30 s desde config CURRENT; constructor no acepta `maxAgeMs` del caller                                                         | `does not let a caller-selected freshness allowance certify an old book`; `preserves distinct exchange-event and local-receive clocks in a verified point frame`                       | Pasa; el límite alterado no puede certificar libro antiguo                           |
| Unknown no certifica nuevos fills ni resultado total               | `replayPairedExecutions()` exige intervalo verificado tras señal; gaps invalidan posición abierta sin borrar fill previo ni producir PnL terminal                     | `reconnect checkpoint...`; `marks loss of archived depth coverage unknown and never turns it into zero PnL`; integración CLI de gap antes/después de entrada                           | Pasa; estado unknown y PnL ausente                                                   |
| Freeze/hash sólo se aplican después de verificar                   | WeakSet y congelado protegen identidad/mutación en proceso, mientras todas las pruebas causales anteriores evalúan el contenido fuente                                | rechazo de frame clonado/resultado caller-authored en `MicroBurstCausalArchive.test.ts`; pruebas de gaps, timestamps, continuidad y frescura arriba                                    | Pasa; la marca no reemplaza verificación de archivo                                  |

La carpeta histórica `data/micro-burst/collector-20261002-v2/` declara realmente
`MICRO_COLLECTOR_FROZEN_V1`; no satisface el productor V2 requerido y se deja intacta.
No se ha verificado una sesión real compatible con episodio, por lo que la validación de
mercado real permanece pendiente. No hace falta reprocesar el archivo grande para esta
demostración.
