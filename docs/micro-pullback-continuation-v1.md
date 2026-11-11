# Micro pullback continuation V1 — experimento de selección

## Punto de partida

Snapshot previo a cambios: commit `5e29823`, sobre `8da4881`.
El commit preserva instrumentación, ventanas de evidencia de salida, extremos de
precio, checkpoints, archivo diferido, auditores y documentación operativa.
Es una instantánea del trabajo previo, no una certificación de rentabilidad.

## Implementación inicial

`src/tooling/micro-burst/MicroBurstPullbackCandidate.ts` es tooling de investigación:
no se importa desde el runtime y no puede enviar órdenes. `evaluate()` llama a la
política CURRENT real con el contexto, libro y relojes de la misma observación.
Conserva íntegra esa decisión como referencia y emite una clasificación shadow.

La candidata V1 es deliberadamente un subconjunto de CURRENT. Exige:

1. CURRENT acepta; setup TREND_RETEST_CONTINUATION o BREAKOUT_RETEST_CONTINUATION.
2. Régimen favorable al lado. Recuperaciones/reversiones quedan excluidas.
3. Cobertura verificada de 60 segundos, sin gaps ni truncamiento de capacidad.
4. Flujo firmado y respuesta del precio favorables en 5/20/60 segundos.
5. Persistencia del mismo episodio/lado/setup en observaciones nuevas, con nuevos
   IDs de aggTrade y avance de ambos relojes.

Supuestos de investigación fijados antes de medir: persistencia 3 s, separación
máxima de observaciones 2 s, antigüedad máxima del último trade 2 s, mínimo 3 trades
por ventana, ratio firmado de volumen >=0.1 y respuesta firmada >=1 bp.
No son umbrales calibrados ni valores recomendados para LIVE. Si el replay solo
tiene snapshots cada 5 s, no puede acreditar persistencia de 2 s: no interpolar.

Solo se usan trades con eventTime <= exchangeAsOfMs y receivedAtMs <= observedAtMs.
Los IDs visibles deben ser contiguos y los tiempos de evento no decrecientes.
Rechazos, observaciones repetidas/regresivas, evidencia sin eventos nuevos y huecos
reinician la persistencia. Las ventanas se calculan sobre trades, no sobre liquidez
visible: todavía no se llama absorción a ese resultado.

No se cambian salidas, sizing ni presupuesto de riesgo. QUALIFIED significa solo
que pasó el selector. executionEligibility permanece NOT_EVALUATED: sigue pendiente
admisión por profundidad/cantidad, costes y demora. El score heredado de CURRENT
no es una probabilidad. La distancia al objetivo no se convierte en ganancia media.

## Replay de selección verificado

```bash
npx ts-node src/tooling/micro-burst/MicroBurstPullbackReplayCli.ts <archive-replay-request-v2.json>
```

La solicitud V2 fija `captureRoot`, `fromMs`, `throughMs` y `outputPath`. El replay
abre una sesión cerrada y verifica el artefacto productor, config, hashes de archivos,
índice SQLite, segmentos, gaps y decisiones originales antes de evaluar la candidata.
La ventana debe quedar dentro de la sesión y no superar diez minutos. El reporte
se crea fuera de `capture/` y conserva hash de artefacto/manifiesto por observación.

El replay recorre todas las decisiones originales (incluidas NO_TRADE), rechaza
configuración mezclada y emite resultados de selección, no ejecución ni economía.
El replay pareado modelado vive separado en `MicroBurstPairedExecutionReplay.ts` y
requiere coberturas verificadas para intervalos, profundidad y funding. Cada fill está
etiquetado como modelado y no como fill real; los terminales desconocidos siguen
UNKNOWN. Los supuestos sobre protección inmediata del stop permanecen visibles.

## Pendientes antes de medir ventaja

- Una sesión real cerrada que supere el verificador de productor/captura; ninguna
  prueba sintética sustituye esa validación.
- Un episodio real CURRENT con cobertura continua, inputs originales, checkpoints y
  terminales de ambas variantes; el replay implementado no crea esa evidencia.
- Captura de frecuencia suficiente, con decisiones rechazadas y cobertura de
  calentamiento; actualmente el archivo crudo LIVE quedó desactivado.
- Revisión de los supuestos del replay económico (incluida demora de protección) y
  certificado de episodio real reproducible antes de presentar resultados económicos.
- Episodios independientes, particiones temporales purgadas y prueba final intacta.
- Comparación de retorno neto, intervalo de incertidumbre, concentración y estrés
  de costes. No optimizar sobre SOL/AVAX ni cientos de combinaciones.
- Sizing por pérdida monetaria al stop como experimento separado; no incorporarlo
  simultáneamente para atribuir a la entrada cambios producidos por exposición.

No se desplegó esta candidata, no se reinició PM2 y no se modificó configuración
LIVE. La validación usa tsc --noEmit para no reemplazar dist de producción.
