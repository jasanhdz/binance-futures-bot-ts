# Certificación de episodio real: bloqueada por evidencia

## Resultado

No se certifica un episodio económico completo. El intervalo seleccionado tiene
86 188 decisiones válidas NO_TRADE y ninguna ENTRY_INTENT. La tabla
micro_burst_signals del archivo consultado también está vacía.
No transformar un rechazo en entrada ni relajar CURRENT para fabricar un ejemplo.

## Reproducción

```bash
npx ts-node src/tooling/micro-burst/MicroBurstRealEpisodeAudit.ts \
  data/micro-burst/shadow-20261001/research.sqlite \
  data/strategy-blackbox/strategy-decisions \
  decisions-v2.2026-10-01T 1790835835313 1790879969090
```

Ventana: desde 1790835835313 hasta 1790879969090, elegida dentro del solapamiento
de rangos indexados de trades/depth de los símbolos. Un rango indexado no certifica
ausencia de huecos ni iguala relojes local/exchange; solo delimita la búsqueda.
Las decisiones se filtran por evaluatedAtReceivedMs, no por hora del archivo.

La herramienta recorre los gzip completos sin modificarlos, conserva hash de bytes
comprimidos, tamaño, líneas, errores y estabilidad inode/size/mtime. La selección
por prefijo no demuestra completitud global del dataset.

Primera decisión válida en ventana: 1790835838544.
Última decisión válida en ventana: 1790879967944.

## CURRENT desde inputs originales

Se reprodujeron once controles negativos (uno por símbolo). Todos coincidieron en
decisión, motivo, confianza y campos de niveles publicados; son rechazos durante
calentamiento, no pruebas de geometría de entradas aceptadas.

Ejemplo SOL:

- Archivo: decisions-v2.2026-10-01T06-27-10-642Z.1.jsonl.gz, línea 459.
- decisionId: 15601de1-5da1-42dc-806a-30747df7bab1.
- SHA-256 del archivo comprimido: d1dd215952792c918e409e2458139b19a6addc9bf449a80f4cf4eb1f28e83abe.
- SHA-256 canónico del replay: cb65a8b9140ec55228ee6b839abbb460654f34118d9b4bf935cab7a35264d333.
- Resultado almacenado/reproducido: NO_TRADE / REACTION_CONTEXT_INVALID.
- Config del evaluador: SHA-256 5a8c84064d1c07b348da9f7c764c7882aede001936251cf26c0b6a825670500e.
- Velas originales: 99 de 1m, 79 de 3m, 59 de 5m; contexto BTC presente.

Estas velas/contexto conservados permiten reevaluar, pero no certificar su historial
crudo previo. El hash de config del evaluador no tiene por qué coincidir con el de
configuración runtime completa: no se comparan como si fueran el mismo documento.
El commit histórico registrado 88199bcbeffe0008d2a8e1070cf0fa6aa9aedd9e no prueba
que el código desplegado coincidiera con ese commit. La coincidencia obtenida es
numérica con el evaluador actual; identidad completa de dependencias no certificada.

Se detectó una línea malformada en decisions-v2.2026-10-01T23-59-09-052Z.1.jsonl.gz.
No se puede asignar con certeza el timestamp de una línea no parseable. Se cuenta
como limitación de evidencia, no se afirma ausencia absoluta de entradas perdidas.

## Criterios aún abiertos

1. Episodio ENTRY_INTENT real con contexto y geometría reproducidos.
2. Calentamiento, BTC y trayectorias cubiertos hasta cierre de ambas variantes.
3. Traza de decisión/demora/book/cantidad/VWAP/costes para cada ejecución.
4. Sensibilidad a demora de protección del stop antes de conclusiones económicas.

El replay implementado compara presupuesto monetario igual, NO reproduce sizing
LIVE por MARGIN_FRACTION. Su supuesto de protección inmediata debe seguir visible;
ningún resultado del replay actual certifica riesgo con protección retrasada.

Se añadió traza por fill modelado (entryAudit/exitAudit): decisión, instante mínimo
tras demora, instante aplicado, cantidad, VWAP antes de slippage, precio final,
comisión, lado consumido, niveles conocidos y SHA-256 de esos niveles. Se marca
expresamente que el tiempo del frame no sustituye la procedencia del checkpoint y
de sus deltas. Esta traza ya se verifica en la prueba sintética, pero no hay fills
reales reproducidos en esta ventana para certificar el criterio 3.

Próxima evidencia necesaria: una captura que incluya una entrada real de CURRENT
y toda su trayectoria causal. No se alteró LIVE ni sus umbrales para conseguirla.
