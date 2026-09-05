# Prompt para Codex local

Continúa el endurecimiento de `jasanhdz/binance-futures-bot-ts`, directamente en
`work/micro-burst-rider-v1-20260826`, sin crear ramas nuevas.

Primero inspecciona el árbol local. Preserva mis cambios con un checkpoint revisado antes de
cambiar de rama o integrar: incluye solo código/documentación pertinente, nunca credenciales,
`.env`, logs privados, datasets sensibles ni `node_modules`. Si encuentras secretos o cambios
que no puedas preservar sin riesgo, detente y pregunta. No uses `git add .` a ciegas.

Haz fetch del remoto y descarga el incremento que contiene:

- `docs/audits/SAFETY_PHASES_HANDOFF.md`
- `docs/audits/SAFETY_HANDOFF_VALIDATION.md`
- este archivo.

Si ya estás en Micro y no hay divergencia, usa integración fast-forward. Si el checkpoint local
diverge, inspecciona y conserva ambos trabajos; no hagas force push ni merge/rebase automáticos
sin revisar conflictos. Verifica rama y commits antes de modificar.

Lee por completo `AGENTS.md` y los dos documentos de traspaso. Revisa también el diff: hay
incrementos PARCIALES de las fases 1, 2 y 5, no fases completas. Reproduce build y los dos grupos
de tests indicados: el resultado de referencia es 1.594/1.594 correctos.

Continúa con los TODO y pseudocódigo del traspaso, en orden de prioridad: completa 0/1/2, luego
3/4/5/6, después 7/8/9 y finalmente 10. Por cada fase: reproduce el bug, implementa una corrección
acotada, ejecuta pruebas normales/adversariales y regresión, actualiza el checklist con evidencia,
haz commit y publica en la misma rama Micro. No marques una fase completa solo porque compila.

Mantén la salida inteligente de Micro: sin trailing ni TP obligatorio. Confirma el supervisor
existente antes de duplicarlo. Preserva los contratos OFF/SHADOW/ENFORCE. No cambies exposición,
umbrales LIVE o manifiestos de aprobación sin una decisión explícita. Si falta presupuesto de
riesgo o datos históricos para una fase, solicita ese dato y registra el bloqueo, sin inventarlo.

No arranques el bot, PM2, servicios LIVE, soak ni envíes órdenes Binance. No cambies credenciales
ni YAML LIVE. Publicar código no autoriza desplegar. No conviertas un test fallido en verde
eliminando assertions de seguridad, relajando umbrales o silenciando errores.

Reporta en español y al grano: fases completadas/parciales/bloqueadas, cambios, tests exactos,
commits, confirmación de push y siguiente tarea. Distingue siempre probado/publicado/desplegado.
