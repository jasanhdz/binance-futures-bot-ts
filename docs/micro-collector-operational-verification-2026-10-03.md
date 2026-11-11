# Hito 1: captura observacional operativa, piloto SOL/AVAX

## Despliegue

Inicio real: 2026-10-03 aproximadamente 02:35:45 UTC.
PM2: `03-Micro-Collector`, PID observado 107277, proceso separado, nice=10.
Raíz: `data/micro-burst/collector-20261002-v2` (el nombre del directorio no es la
hora de inicio). Duración configurada: 86 400 s, sin autorestart. Al terminar hay
que lanzar una sesión nueva: no se sobrescribe effective-config.json ni se mezclan
sesiones. El primer intento v1 quedó incompleto al copiar types inexistente; no se
ejecutó y se conservó. v2 admite ese directorio opcional.

Scope: SOLUSDT y AVAXUSDT, con contexto BTC del productor; no se certifican los
otros nueve símbolos. Modo SHADOW, claves vacías y dotenv dirigido a /dev/null.
Usa MarketDataPort bajo createReadOnlyAuditedExchange, sin puerto LIVE.
No se modificó ni reinició `01-Trading-Bot` (PID 11301).

## Identidad reproducible

MicroBurstCollectorFreeze copia src, dependencias, lockfile, config y compila desde
esa copia. No modifica dist del bot. manifest.json incluye bytes identificados por
hash de todos los archivos de código y dependencias, y sourceDirty=true.
Commit informativo: 5e2982311d7f97c0b961771e27fc1b1c138d4a80.
Artifact SHA-256: 724667b22931f122966a0939f825f2098187d84d3e653941fd1e57cac31f92ad.
Config efectiva del recolector: c2baec4c2e01c6386b4c0829af214e8080ed41b98591813062980c73975bb39b.
El worker ejecuta code/ y resuelve las dependencias copiadas en su propia raíz.
La verificación posterior rehasheó code/ y node_modules/: ambos coinciden.
Node se identifica por versión/plataforma/arquitectura; no es imagen hermética del SO.

## Datos y cadencia

- Trades y deltas crudos con tiempos de evento/recepción y secuencias.
- Checkpoints cada 1 s; profundidad conocida de 20 niveles por lado.
- Respuestas REST de velas, snapshots originales y reloj con inicio/fin de petición.
- Inputs exactos de CURRENT (velas, BTC, flujo, libro), decisiones aceptadas/rechazadas.
- ENTRY_INTENT registra episodio y contexto en episodes.jsonl; la captura continúa.
- El paper genérico no se considera comparación económica de la candidata.
- Se programa evaluación cada 500 ms, pero la cadencia real se mide por símbolo.
- Intervalos >2 s se registran como OBSERVATION_CADENCE_GAP; no se interpolan ni
  se cambia el umbral de persistencia para acomodarlos.

Medición a 512.155 s: SOL 602 observaciones, 4 intervalos >2 s, máximo 3186 ms;
AVAX 588, 10 intervalos >2 s, máximo 2625 ms. Últimos intervalos 689/562 ms.
La cadencia es útil en tramos continuos, NO es una garantía universal de <=2 s.
La selección del episodio deberá rechazar ventanas atravesadas por estos huecos.

## Impacto medido

- 1190 evaluaciones, cero errores.
- 1190 observaciones escritas, cero dropped/failed; colas pendientes 0.
- Archivo saludable, 9017 registros finalizados reportados, cero overflow/storageErrors.
- Cero intentos de mutación y cero mutaciones reenviadas.
- RSS 250 576 896 bytes (~239 MiB).
- CPU acumulada user+system 34.96 s en 512.16 s (~6.8 % de un núcleo promedio).
- Event-loop p99 126.9 ms. Última escritura de observación 7.41 ms; espera 0.006 ms.
- Captura ocupaba 208 882 071 bytes (~199 MiB); rotación/compression hace variable
  el tamaño instantáneo. No extrapolar este único punto como tasa de disco estable.
- Disco disponible observado: 587 GiB.

LIVE antes/después: mismo PID y RUNNING/LOOP_READY; ticks 42663 → 42892 entre
02:35:25 y 02:43:14 UTC; fallos de evaluación 0, descartes 0, cola 0 y sin eventos
de rate limit. RSS ~889.3 MB → ~888.3 MB. Esto es una comprobación breve de ausencia
de degradación observada, no una prueba causal de impacto nulo a largo plazo.

## Replay real posterior al calentamiento

Reporte: `verification-1790995462022.json` en la raíz de sesión.
Se conservaron extractos inmutables con offsets exactos de bytes del journal activo,
excluyendo bordes parciales. Sus hashes y rutas están en el reporte. No se declara
cobertura global por leer esos extractos.

Diez decisiones reales (cinco por símbolo), posteriores a 300 s, con contexto
válido y rechazo REACTION_NO_QUALIFIED_SIDE: todas coincidieron al ejecutar el
evaluador congelado sobre sus inputs originales.

Para cada una se seleccionó checkpoint ya persistido antes de la decisión y se
aplicaron deltas disponibles hasta el timestamp del libro original. Todas coinciden
en precios/cantidades dentro de los niveles conocidos y en timestamp del libro.
Se compararon 20 bids y 17–20 asks según el límite verificable del checkpoint.
No se afirmó profundidad fuera de ese límite.

Ejemplo: c7b16c69-e49b-4594-ab96-b40fe34652a7 (SOL), decisión 1790995247178;
checkpoint 1790995246454, persistido 1790995246524; libro 1790995247111;
seis deltas reproducidos, 20/20 niveles coincidentes.

```bash
npx ts-node src/tooling/micro-burst/MicroBurstCollectorVerification.ts \
  data/micro-burst/collector-20261002-v2
```

## Límites y segundo hito

Se cierra la puesta en marcha y verificación de un tramo real para este piloto.
No se certifica continuidad absoluta de la sesión ni un episodio económico.
Todavía no se observó/validó aquí una entrada completa CURRENT frente a PULLBACK.
Los episodios necesitan intervalos elegibles, historial, BTC y recorrido hasta ambos
terminales; fin de sesión no implica cierre económico. Las demoras de protección
del stop siguen siendo otro requisito del replay económico.

El archivo malformado antiguo permanece en cuarentena analítica: excluirlo crea
un hueco explícito, no continuidad. La sesión nueva no lo importa.

El recolector permanece activo durante la ventana configurada. Verificar health.json,
crecimiento de archivos y gaps; si el productor se detiene, no extrapolar captura.
La expansión a todos los símbolos requiere volver a medir capacidad/cadencia.
