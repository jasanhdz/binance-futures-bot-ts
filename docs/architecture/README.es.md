# Arquitectura del runtime — guía en español

La referencia canónica, mantenida contra el código actual, está en [`README.md`](./README.md).
Esta página sustituye la traducción extensa que se había separado de la implementación.

## Fronteras

- **Datos compartidos:** `SharedMarketDataRuntime`, `CandleDataPlane`, `OrderBookDataPlane`,
  `AggTradeDataPlane` y el `MarketSnapshotProvider` mantienen observaciones/estado de mercado.
- **Estrategia:** `StrategyRouter` evalúa la política con identidad, contrato y contexto tipado.
  Una intención no es una autorización de ejecución.
- **Riesgo/seguridad:** límites de cuenta y la reserva compartida pueden rechazar entradas;
  deben permitir que posiciones ya abiertas sigan siendo gestionadas.
- **Ejecución/paper:** `SharedStrategyExecutionService` es la frontera de mutación existente.
  `ShadowTradingEngine` permite evaluar políticas en papel con ownership y recuperación separados.
- **Posiciones:** `PositionManagerRouter` resuelve por identidad persistida; no debe transferir
  ownership entre estrategias.

Micro conserva la interpretación de velas, régimen, estructura, momentum, BTC, depth/flow,
entradas y salidas. En runtime se alimenta del libro y AggTrade compartidos, pero su lectura
de velas mantiene el adaptador REST y el `snapshotAtMs` de Micro: no se sustituyó por la
clasificación del plano de velas porque sus límites de disponibilidad no son equivalentes.

El `TEST_PROBE` documentado en tests es exclusivamente sintético: no aparece en configuración
operativa y el servicio de ejecución lo rechaza explícitamente. ONNX, entrenamiento Python y
serving no están implementados; el límite futuro y el contrato de features se describen en la
referencia canónica.
