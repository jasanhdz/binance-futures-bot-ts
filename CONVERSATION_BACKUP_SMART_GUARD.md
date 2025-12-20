# Respaldo de Conversación: Optimización de Logging, Smart Guard y Ajuste de Apalancamiento
**Fecha:** 16 de Diciembre de 2025
**Asistente:** Antigravity (Google DeepMind)
**Usuario:** Jasan

Este documento resume la sesión de pair programming enfocada en la mejora del sistema de logging, la implementación de protecciones de ganancias (Smart Guard) y la corrección crítica de la gestión de riesgo (Apalancamiento y Cooldown).

---

## 1. Objetivo Inicial: Limpieza de Logs
**Problema:** El bot saturaba los logs repitiendo señales `ENTER` y confirmaciones de creación de brackets (`SL`/`TP`) en cada tick (cada segundo).

**Solución Implementada:**
1.  **Deduplicación de Señales (`StrategyRunner.ts`):**
    *   Se añadió caché (`lastLoggedSignals`) para no repetir logs si la acción y razón son idénticas.
    *   Se limitaron los logs de `IDLE` a uno cada 5 minutos.
2.  **Deduplicación de Brackets (`ensure-brackets.ts`):**
    *   Se modificó la interfaz `Exchange` para que `placeStopClose` y `placeTpClose` devuelvan un `boolean` (`true` = orden creada, `false` = ya existía).
    *   El guard ahora solo emite el log `ensure_stop_created` si el exchange confirma que la orden es nueva.

---

## 2. Implementación del "Smart Profit Guard"
**Contexto:** El usuario reportó una posición en `SOLUSDT` que alcanzó +52% ROI pero no se cerró porque el Take Profit fijo estaba más lejos, poniendo en riesgo la ganancia ante un retroceso.

**Solución:** Se inyectó lógica de salida inteligente en `StrategyRunner.ts` (dentro del ciclo `tick`):

### A. Trailing Profit Lógico
Protege ganancias masivas sin cortar la tendencia prematuramente.
*   **Regla:** Si `ROI > 30%` (se registra como pico) y luego el precio cae devolviendo un **30%** de esa ganancia máxima.
*   **Acción:** Cierre inmediato de mercado.

### B. ML Decay Exit (Salida por Debilidad)
Respeta la "opinión" del modelo en tiempo real.
*   **Regla:** Si `ROI > 10%` (ganancia mínima) **Y** la probabilidad actual del modelo cae por debajo del umbral de entrada original.
*   **Acción:** Cierre inmediato. "Si el modelo ya no confía, nosotros tampoco".

---

## 3. El Incidente del Re-ingreso y el Cooldown
**Incidente:** Tras activar el Smart Guard, el bot cerró `SOLUSDT` con ganancia (+20%), pero **volvió a entrar 10 segundos después** en la misma dirección (SHORT) porque el modelo seguía dando señal. El mercado rebotó y la nueva posición tocó Stop Loss (-67%).

**Diagnóstico:** Falta de "enfriamiento" tras una salida. El modelo tiene lag y no debe operarse inmediatamente después de un cierre.

**Solución:** Se implementó un **Cooldown Obligatorio** en `StrategyRunner.ts`.
*   **Código:**
    ```typescript
    const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutos
    if (stBefore.lastExitAt && Date.now() - stBefore.lastExitAt < COOLDOWN_MS && stBefore.lastSide === side) {
        return; // Bloquear entrada
    }
    ```
*   **Resultado:** El bot ahora espera 15 minutos antes de considerar re-entrar en la misma dirección, evitando la "trampa del re-ingreso".

---

## 4. Auditoría y Ajuste de Apalancamiento
**Problema:** El usuario notó pérdidas desproporcionadas (-67%) ante movimientos pequeños del precio (-2.2%).
**Hallazgo:** Aunque el archivo `.env` indicaba 15x, el bot estaba operando a **30x**. Se descubrió un archivo oculto generado por el sistema de ML (`models/advanced/thresholds_config.json`) que sobreescribía la configuración.

**Solución:** Se editó tanto el archivo oculto como el `.env` para establecer una **Estrategia de Apalancamiento Híbrida** basada en el Sharpe Ratio de los modelos:

### Configuración Final de Apalancamiento:
*   **TOP TIER (15x):** Modelos con alto rendimiento y confianza.
    *   `XRPUSDT` (Sharpe 6.59)
    *   `ADAUSDT`
    *   `LINKUSDT`
    *   `SOLUSDT`
*   **STANDARD TIER (10x):** Modelos más volátiles o con menor Sharpe.
    *   `BTCUSDT`
    *   `ETHUSDT`
    *   `AVAXUSDT`
    *   `SNXUSDT`

---

## 5. Archivos Clave Modificados
*   `src/app/strategy-runner.ts`: Lógica de Smart Guard, Cooldown y Deduplicación.
*   `src/app/guards/ensure-brackets.ts`: Control de logs de brackets.
*   `src/infra/binance/BinanceExchange.ts`: Retorno booleano en creación de órdenes.
*   `.env`: Ajuste de apalancamientos.
*   `models/advanced/thresholds_config.json`: Ajuste de apalancamientos (Source of Truth del ML).

---

**Estado Final:** El bot está operando con logs limpios, protegiendo ganancias activamente, respetando tiempos de enfriamiento y utilizando un apalancamiento adecuado al riesgo de cada activo.
