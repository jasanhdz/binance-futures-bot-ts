# Contratos de estrategia — guía en español

La especificación canónica es [`STRATEGY_CONTRACTS.md`](./STRATEGY_CONTRACTS.md); este archivo
es una guía breve para evitar una segunda especificación traducida que se desincronice.

## Contrato actual

`EntryStrategy` mantiene identidad y modo y puede declarar configuración, inputs tipados,
calentamiento, estado propio, manager de posición y requisito de recuperación. `StrategyRouter`
registra el contrato, conserva el resultado de política y normaliza el estado como `INTENT`,
`REJECTED`, `WAIT` o `NOT_EVALUABLE`. Los adaptadores antiguos todavía pueden no declarar
contrato; esa ausencia no se interpreta como una autorización ni como requisitos conocidos.

La identidad de cada trade no cambia al pasar por riesgo, ejecución, paper o recovery. El
`PositionManagerRouter` enruta por el `strategyId` persistido; la ejecución compartida puede
rechazar una intención y nunca delega ownership. Micro es la referencia técnica; no hay una
afirmación de rentabilidad demostrada.

El contrato de schema de features contempla nombre, orden, tipo, unidades, disponibilidad,
ausencia y warmup. Una predicción futura será evidencia de entrada a la estrategia, nunca una
orden. No hay entrenamiento, ONNX runtime ni serving implementados.
