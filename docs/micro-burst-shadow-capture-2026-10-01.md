# Captura Micro SHADOW — 2026-10-01

## Estado posterior: retorno LIVE solicitado por el usuario

Se restauró la configuración LIVE original autorizada, hash
`132879584379e97474309df05d99552a6b835fecdcbe38d3b586b7bfb76633e1`.
Verificación final: PID 7307, RUNNING/LOOP_READY, liveExecution true,
liveAuthority true. Ledger revisión 42, epoch 1, streak 0, halted 0.
La captura cruda y prospective_validation quedaron desactivadas: la configuración
con captura no coincidía con la identidad LIVE aprobada y la recuperación del
archivo retrasaba el arranque. Los datos capturados permanecen conservados.
Los locks de procesos terminados 297524 y 6929 fueron conservados como evidencia
con PM2 detenido y ausencia de los PIDs verificada. La descripción siguiente
corresponde a la activación SHADOW anterior, no al estado operativo actual.

## Activación

Configuración: `regime_config.live.yaml`.

- Micro `mode: SHADOW`; ejecutor LIVE no conectado.
- `prospective_validation.enabled: true`.
- `market_archive.enabled: true`, trades y depth crudos habilitados.
- Archivo: `data/micro-burst/shadow-20261001/market-data`.
- SQLite: `data/micro-burst/shadow-20261001/research.sqlite`.
- Cohorte observada: `MB-COHORT-88199bcbeffe-2827a1beac7f`.
- Config hash: `2827a1beac7ff821c8505b992d657ff00452fa8ab1cda0c2b2327f96ea404937`.

Al iniciar la intervención, el ledger estaba en revisión 42, epoch 1, streak 0,
halted 0. No se restableció ni modificó: SHADOW impide nuevas entradas Micro
independientemente de ese estado. No confundir el modo general de proceso
`AEGIS_TURBO_MICRO_LIVE` con `microBurstRuntime.liveExecution`, que debe ser false.

El primer arranque con el archivo histórico no respondió. Se separó la captura
nueva. El proceso anterior dejó locks del PID 288811; con PM2 detenido y el PID
ausente, se conservaron en `data/runtime/lock-recovery-evidence-20261001/` y se
reinició normalmente. No se borraron journals de ejecución ni archivos históricos.

## Comprobación inicial

- PID 289724, RUNNING/LOOP_READY.
- liveExecution false, liveAuthority false.
- Archivo saludable, cola sin desbordamientos y cero errores de storage.
- Registros durables en segmentos activos y checkpoints de los 11 símbolos.
- Checkpoints examinados: lastUpdateId y 20 niveles por lado.
- 97 tests de configuración, runtime y storage aprobados; build aprobado.

Comprobación posterior al primer cierre de segmentos: 11 libros saludables,
22 segmentos finalizados, 19 513 registros durables, cero overflow/errors y cero
mutaciones reenviadas. 292 observaciones black-box escritas, cero dropped/failed.
Se descomprimieron los primeros segmentos de trades/depth de SOL y AVAX y se
verificaron SHA-256 del NDJSON, fin de línea y record_count contra el índice.
Los trades incluyen aggregateTradeId/firstTradeId/lastTradeId; depth incluye
E/T/U/u/pu; ambos conservan receivedAtMs. Esta comprobación de integridad no
certifica automáticamente continuidad entre segmentos ni ejecución a cantidad.

La captura inicial no certifica continuidad futura ni rentabilidad. Un checkpoint
de 20 niveles no permite inferir profundidad fuera de su cobertura. Para VWAP hay
que disponer de cantidad suficiente dentro del libro reconstruido y validar pu/U/u,
orden temporal, timestamps y gaps. Descartar calentamiento y tramos incompletos.

## Referencia y comparación

La referencia económica es la política Micro vigente con sus salidas reales.
`paperEngine: GENERIC` o resultados a horizonte fijo no sustituyen esa referencia.
El replay debe ejecutar la política de salida correspondiente sobre inputs causales,
modelar entrada/cierre a cantidad y contabilizar costes. Sin esos requisitos, marcar
resultados como descriptivos/no elegibles para atribuir ventaja.

Capturar también NO_TRADE mediante la observación black-box existente; no seleccionar
solo señales aceptadas. Para investigación usar cohortes, episodios independientes,
separación temporal y las hipótesis preregistradas en
`micro-burst-loss-review-2026-09-29.md`.

No se han ejecutado ni validado todavía variantes de persistencia, alcanzabilidad
y contexto en una muestra nueva suficiente. El diagnóstico conserva blockers de
manifest/schema/episode/cost/mutation: no declarar esta cohorte oficial o lista para
LIVE mientras existan. La huella de commit no identifica cambios locales sin commit.

## Seguimiento

1. Verificar avance de ticks, 11 libros, archivo saludable y cero overflow/errors.
2. Comprobar segmentos finalizados e indexados, integridad y continuidad por ventana.
3. Conservar decisiones rechazadas y registrar exclusiones por falta de evidencia.
4. Revisar volumen en disco: retención de trades en memoria no equivale a borrado
   automático del archivo. No eliminar evidencia antes de analizarla.
5. Construir replay económico de la referencia antes de comparar variantes.
6. La vuelta a LIVE requiere evaluación fuera de muestra y decisión explícita.
