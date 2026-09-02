# Auditoria read-only de diversidad de predicciones Aegis

Fecha de observacion: 2026-09-02

Nota de cierre: la auditoria contrafactual posterior `AEGIS_PROBABILITY_REGRESSION_AUDIT_20260902.md` completa la instrumentacion que faltaba en este informe provisional. Confirma features y scores calibrados variables, identifica la semantica de `HOLD/1.000` y no encuentra regresiones entre las revisiones historicas auditadas.

## Objetivo

Determinar si Aegis recibe entradas diferentes para los once simbolos canonicos y si sus probabilidades y scores cambian, o si el pipeline permanece atascado en una salida numericamente identica que impide operar.

Esta auditoria fue estrictamente observacional. No se modificaron codigo, configuracion, YAML, variables de entorno, modelos, features, thresholds, riesgo ni autoridad LIVE. No se reiniciaron procesos PM2, no se cambiaron condiciones para provocar senales y no se realizaron mutaciones Binance. Micro Burst permanecio en `SHADOW` con `liveExecution=false`.

## Conclusion ejecutiva

La evidencia observada confirma que el transporte TypeScript -> Aegis estaba activo y que Aegis estaba ejecutando inferencias reales para los once simbolos. No era un caso de ausencia de inferencia: el contador de requests crecio, el timestamp de ultima inferencia avanzo y el servicio devolvio decisiones para todos los simbolos.

La salida visible en los logs fue extraordinariamente uniforme:

- accion raw: `HOLD`;
- accion gated: `HOLD`;
- score mostrado: `1.000`;
- razon dominante: `HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT`.

Sin embargo, la auditoria anterior no capturo `long_prob`, `short_prob`, `no_trade_prob`, `turbo_score` con precision completa, `context_hash`, `feature_hash`, `market_timestamp` ni un indicador de cache por cada respuesta. El log operativo solo mostraba una accion y un score redondeado a tres decimales. Por ello, no es cientificamente correcto afirmar a partir de esa evidencia que las probabilidades internas fueron exactamente iguales, ni tampoco afirmar que fueron variables.

La clasificacion operacional mas compatible con lo observado es:

`PREDICTIONS_VALID_BUT_MODEL_SATURATED` (provisional)

Es provisional porque se demostraron inferencias validas y una salida visible persistentemente `HOLD`, pero no se midio la diversidad numerica de las probabilidades ni de las features con la instrumentacion necesaria. La auditoria descarta razonablemente `PREDICTIONS_PIPELINE_BLOCKED`, pero no cierra de forma definitiva la diferencia entre saturacion real del modelo y una posible reutilizacion de entradas/salidas que no sea visible en el log resumido.

## Alcance real de la observacion

Se observaron aproximadamente quince minutos mediante catorce capturas periodicas del log de produccion. Cada captura volvio a leer una ventana solapada de las ultimas 2.000 lineas. El archivo de analisis acumulo 13.892 filas parseadas.

Ese numero no representa 13.892 inferencias unicas. Incluye duplicados porque las ventanas de log se solapaban entre capturas. En consecuencia:

- los conteos por simbolo sirven para confirmar presencia repetida de los once simbolos;
- no sirven como contador exacto de actividad durante el periodo;
- no deben compararse directamente con el incremento del contador de requests de Aegis;
- no permiten calcular una frecuencia exacta de inferencias por simbolo.

La auditoria si confirmo que los once simbolos aparecieron repetidamente en las decisiones:

`BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `BNBUSDT`, `XRPUSDT`, `DOGEUSDT`, `ADAUSDT`, `AVAXUSDT`, `LINKUSDT`, `SUIUSDT` y `LTCUSDT`.

## Resultados visibles por simbolo

Los siguientes conteos son filas parseadas de ventanas solapadas, no predicciones unicas. Se conservan solo como evidencia de cobertura y uniformidad de la salida visible.

| Simbolo | Filas observadas | Accion visible | Score visible | Veredicto dominante |
|---|---:|---|---:|---|
| ETHUSDT | 1.311 | HOLD | 1.000 | HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT |
| BTCUSDT | 1.323 | HOLD | 1.000 | HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT |
| SOLUSDT | 1.348 | HOLD | 1.000 | HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT |
| BNBUSDT | 1.235 | HOLD | 1.000 | HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT |
| XRPUSDT | 1.366 | HOLD | 1.000 | HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT |
| DOGEUSDT | 1.327 | HOLD | 1.000 | HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT |
| ADAUSDT | 1.154 | HOLD | 1.000 | HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT |
| AVAXUSDT | 1.143 | HOLD | 1.000 | HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT |
| LINKUSDT | 1.294 | HOLD | 1.000 | HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT |
| SUIUSDT | 1.264 | HOLD | 1.000 y cuatro fallbacks 0.000 | HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT; cuatro `ml_predict_unavailable` |
| LTCUSDT | 1.127 | HOLD | 1.000 | HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT |

En total, 13.888 filas mostraron `HOLD/1.000` con `HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT`. Cuatro filas mostraron el fallback defensivo `ml_predict_unavailable` con score visible `0.000`. Esas cuatro filas no son evidencia de diversidad del modelo: son respuestas defensivas del cliente ante indisponibilidad puntual.

## Lo que si quedo demostrado

### 1. El pipeline no estaba bloqueado

El contador acumulado de requests de Aegis aumento durante la observacion y `latest_inference_timestamp` avanzo. Aegis permanecio `ready=true`, con `errors=0`, y produjo decisiones visibles para los once simbolos.

Esto diferencia una salida `HOLD` legitima de la ausencia de inferencia. Habia actividad real en el periodo.

### 2. Los once simbolos participaron

Los once simbolos canonicos aparecieron repetidamente en el log de decisiones. No se observo que un subconjunto fijo monopolizara todas las llamadas ni que un simbolo faltara permanentemente.

### 3. La salida visible fue practicamente constante

Para todas las respuestas de modelo visibles, la combinacion fue:

`HOLD / 1.000 / HYBRID_DIRECTIONAL_ABSTAIN_OR_WAIT`

La varianza y el rango del score visible, excluyendo los cuatro fallbacks `ml_predict_unavailable`, fueron cero en la precision expuesta por el log:

- minimo: `1.000`;
- maximo: `1.000`;
- rango: `0.000`;
- varianza visible: `0.000`.

Esto demuestra uniformidad de la salida resumida, no necesariamente identidad bit a bit del score interno ni de las probabilidades subyacentes.

### 4. El transporte WebSocket estaba saludable

La diagnostica de market data mostro, en la comprobacion final:

- once de once simbolos presentes;
- `source=WEBSOCKET` para las series activas;
- estado global observado `FRESH`;
- 319 velas cerradas por serie;
- series alineadas sobre la misma vela cerrada;
- sin evidencia de vela abierta incluida en la serie cerrada;
- REST fallback acumulado distinto de cero en algunos simbolos tranquilos, pero fuente final WebSocket;
- ninguna evidencia de que el silencio de un simbolo equivaliera a una caida del transporte.

Los contadores de fallback eran acumulados desde el arranque y no representan necesariamente actividad REST dentro de la ventana auditada.

### 5. Aegis estaba operativo

Durante la auditoria se observo:

- `ready=true`;
- `feature_count=83` en health/runtime;
- `errors=0`;
- `latest_inference_timestamp` avanzando;
- E4 activo y sin error de ciclo visible;
- `python_exchange_mutations=0`;
- procesos PM2 online y sin reinicios espontaneos observados.

## Lo que no quedo demostrado

### 1. No se midieron las probabilidades individuales

El log parseado no contenia `long_prob`, `short_prob` ni `no_trade_prob`. Por tanto, no se pudieron calcular correctamente:

- valores unicos por probabilidad;
- varianza por probabilidad;
- rango por probabilidad;
- diferencias entre simbolos;
- evolucion temporal de cada probabilidad.

No se puede usar el `1.000` del texto `raw=HOLD/1.000` como sustituto automatico de `no_trade_prob`. Ese valor es el score que la capa TypeScript eligio mostrar y su semantica exacta debe obtenerse del payload de respuesta, no inferirse del formato de log.

### 2. No se capturaron hashes de contexto ni de features

No se registraron `context_hash` ni `feature_hash` por inferencia. La presencia de distintos simbolos y timestamps de log sugiere actividad sobre momentos diferentes, pero no prueba criptograficamente que el vector de 83 features haya cambiado entre respuestas.

Por esa razon, la afirmacion "las features cambian pero las salidas permanecen iguales" no quedo certificada por esta ejecucion concreta.

### 3. No se midio el uso de cache por respuesta

El incremento de requests y de `latest_inference_timestamp` demuestra llamadas activas, pero no basta para saber si cada respuesta fue:

- una inferencia nueva;
- una respuesta reutilizada por una cache valida del mismo `market_timestamp`;
- una combinacion de ambas.

No se capturo un campo `cache_hit`, una cache key ni un identificador de inferencia por respuesta.

### 4. No se capturo el contrato completo de market context por respuesta

La salud general del runtime y la diagnostica de market data respaldan el transporte WebSocket. Sin embargo, el dataset parseado no guardo por cada prediccion:

- `source=TYPESCRIPT_SHARED_WEBSOCKET`;
- `rest_snapshot_provider_used=false`;
- exactamente once series;
- cantidad de velas por serie;
- cierre y alineacion de la ultima vela.

Estos atributos habian sido certificados en pruebas anteriores de integracion, pero no quedaron unidos fila por fila al dataset de diversidad de esta auditoria.

### 5. La rama solicitada no coincidio con la rama inspeccionada

El prompt de auditoria mencionaba la rama TypeScript `work/micro-burst-rider-v1-20260831`. Durante la inspeccion, el repositorio local reporto `work/micro-burst-rider-v1-20260826`. No se cambio de rama porque la tarea era read-only y no debia alterar el runtime.

Por tanto, este informe describe el runtime que estaba realmente ejecutandose y el repositorio local observado, no certifica especificamente el contenido de `work/micro-burst-rider-v1-20260831`.

## Interpretacion sobre el riesgo de quedar atascado

La preocupacion principal es valida: si las probabilidades de Aegis fueran numericamente constantes por un defecto, el selector podria permanecer indefinidamente en `HOLD` y nunca autorizar una entrada.

La auditoria confirma una senal de alerta operacional: durante toda la ventana, en todos los simbolos, la salida visible fue esencialmente la misma. Eso justifica investigar la diversidad interna con precision completa.

Pero esta auditoria no permite concluir que exista un bug. Hay al menos tres explicaciones compatibles con lo observado:

1. El modelo recibe features diferentes, pero el selector de calidad permanece correctamente por debajo de los thresholds y devuelve `HOLD`.
2. Las probabilidades cambian en decimales no mostrados por el log, pero el score redondeado sigue apareciendo como `1.000` y la accion permanece `HOLD`.
3. Una cache o una entrada efectivamente estable reutiliza resultados, aunque el servicio siga recibiendo requests.

La evidencia disponible favorece la primera explicacion porque el pipeline estaba activo, habia once simbolos y market data saludable. Sin hashes, probabilidades completas y metadata de cache, las explicaciones segunda y tercera no quedan descartadas de forma definitiva.

## Veredicto

### Veredicto operacional

`PREDICTIONS_VALID_BUT_MODEL_SATURATED`

### Nivel de confianza

Medio, no definitivo.

### Motivo

- Hay inferencias reales y cobertura de los once simbolos.
- El transporte TS -> Aegis no esta bloqueado.
- Aegis esta ready y sin errores acumulados durante la observacion.
- La salida visible es persistentemente `HOLD/1.000`.
- No existe evidencia suficiente para demostrar diversidad de probabilidades ni de features.
- Tampoco existe evidencia suficiente para demostrar que todas las probabilidades internas sean exactamente iguales.

## Criterio necesario para cerrar definitivamente la duda

Una certificacion concluyente debe capturar directamente, por cada respuesta valida y sin modificar configuracion:

- timestamp de recepcion;
- simbolo;
- `market_timestamp`;
- `context_hash` calculado sobre el contexto canonico;
- `feature_hash` calculado sobre las 83 features en orden canonico;
- `source`;
- `status`;
- `rest_snapshot_provider_used`;
- `feature_count`;
- `long_prob` con precision completa;
- `short_prob` con precision completa;
- `no_trade_prob` con precision completa;
- `turbo_score` con precision completa;
- accion;
- veredicto;
- razones de gates;
- `cache_hit` o cache key;
- identificador unico de inferencia.

Con esos campos se podra distinguir sin ambiguedad entre:

- features variables con probabilidades variables y decisiones `HOLD` legitimas;
- features variables con salidas numericamente saturadas;
- entradas estancadas;
- cache legitima por el mismo `market_timestamp`;
- reutilizacion indebida de resultados entre simbolos.

## Estado final de la auditoria

No se modifico el sistema para provocar senales. No se cambiaron thresholds ni modelos. No se hicieron commits ni pushes. Los procesos PM2 permanecieron intactos. Los archivos temporales usados para esta observacion inicial fueron eliminados al terminar; este documento se dejo en el proyecto como registro de la evidencia provisional.
