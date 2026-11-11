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

`MicroBurstCaptureSession.ts` abre únicamente sesiones cerradas con hashes
consistentes de productor, config, decisiones, manifiestos, segmentos e índice SQLite.
Rechaza symlinks que escapen de la raíz, archivos temporales, gaps no declarados,
identidades de decisión duplicadas y evidencia de funding sin procedencia verificable.
La cobertura de intervalos exige checkpoints/observaciones suficientes y respeta los
relojes de evento y recepción; no extrapola una sesión a partir de los extremos del
índice SQLite.

La cobertura declarada debe proceder de auditoría de sesión (inicio, fin, gaps,
overflows), no de un booleano elegido por el usuario. El lector verifica integridad,
no puede demostrar por sí solo que se archivaron todos los segmentos de una sesión.
Los checkpoints históricos guardan observedAtMs; antes de convertirlo a receivedAtMs
hay que comprobar su semántica en el productor, nunca sustituirlo por hora del archivo.

## Modelo de ejecución

`MicroBurstPairedExecutionReplay.ts` recibe una serie ordenada por símbolo, con
observación CURRENT/candidata, libro reconstruido y evidencia causal de salida.

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
- Huecos, profundidad de salida insuficiente y final incompleto producen UNKNOWN.
- Funding cero requiere evidencia explícita de ausencia de funding en el intervalo.

**Límites:** asume cobertura inmediata del stop y aplicación inmediata de MOVE_STOP;
no replica demoras/fallos de protección del exchange, ni valida liquidación/margen ni
exposición conjunta entre símbolos. No certifica paridad completa LIVE. La cobertura
entre frames debe verificar que no se omitió un toque de stop o evidencia de salida;
un muestreo cada segundo no basta por sí solo para demostrarlo.

El cambio de sizing aquí es un presupuesto de investigación común a ambas variantes,
no una reproducción del MARGIN_FRACTION LIVE ni una modificación del bot.

## Validaciones realizadas

Prueba determinista con archivo gzip generado: lectura/integridad, cobertura de flujo,
confirmación, libros causales de prueba, entradas distintas, sizing, costes y cierres.
La decisión CURRENT y los checkpoints de esa prueba son fixtures, no reconstrucción
integral del contexto técnico desde mercado crudo.

Las pruebas sintéticas verifican también la apertura/rechazo de sesiones, el vínculo
con decisiones CURRENT originales, evidencia de funding y trazas de ejecución
pareada. No constituyen un certificado de un episodio real. El `MicroBurstEpisodeCapture`
persiste un journal encadenado y marca sesiones incompletas si quedan escrituras
pendientes o faltan terminales; el cierre de captura no equivale al cierre económico
de una posición.

También prueba que una oportunidad consumida durante la espera queda UNFILLED,
que un gap invalida resultados, que la política Micro puede cerrar sin tocar stop,
y que las observaciones repetidas no multiplican episodios en el reporte.

Lectura real read-only de los primeros cuatro segmentos de cada símbolo en
`data/micro-burst/shadow-20261001/research.sqlite`:

- SOL: 2 752 registros, trades y depth, integridad válida.
- AVAX: 2 101 registros, trades y depth, integridad válida.

**Esto no es aún un backtest económico real completo.** Falta enlazar contexto
CURRENT completo, checkpoints, gaps y cobertura de sesión al mismo reloj causal,
conservar huellas de código/dataset y reproducir las decisiones originales.
No cambiar los 2 s ni interpolar snapshots para eludir ese requisito.

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
