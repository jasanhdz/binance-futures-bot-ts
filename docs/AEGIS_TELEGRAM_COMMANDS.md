# Aegis Telegram Commands

Fecha: 2026-05-07.

El bot puede aceptar comandos de Telegram por long polling. No abre puertos, no usa webhook y no expone HTTP público.

## Activación

Los comandos inbound están apagados por defecto.

Variables:

```bash
TELEGRAM_COMMANDS_ENABLED=1
TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321
```

Reglas:

- Si `TELEGRAM_COMMANDS_ENABLED` no es `1`, no se inicia el listener inbound.
- Si `TELEGRAM_ALLOWED_CHAT_IDS` está vacío, se autoriza el `TELEGRAM_CHAT_ID` de alertas como fallback.
- Si ambos están vacíos, no se aceptan comandos inbound.
- Si un chat no está autorizado, el bot responde `Unauthorized.` sin datos sensibles.
- Hay rate limit por chat: máximo 1 comando cada 2 segundos.
- El listener usa el mismo `TELEGRAM_BOT_TOKEN` del bot de alertas.

## Seguridad

Todos los comandos actuales son solo lectura.

No implementan:

- abrir operaciones
- cerrar operaciones
- pausar/reanudar trading
- cambiar thresholds
- cambiar YAML
- cambiar flags live
- modificar órdenes Binance
- tocar Python Aegis

## Comandos

```text
/help
/status
/account
/positions
/config
/signal ETHUSDT
/signals
/risk
/brackets
/report today
```

## Salidas

`/status`

- Bot online/running
- trading mode
- live enabled
- salud de Aegis API
- símbolos activos
- número de posiciones abiertas
- resumen de última señal si está disponible

`/account`

- wallet
- equity total
- disponible
- unrealized PnL
- trades del día
- pérdidas consecutivas
- daily PnL

Los datos no disponibles se muestran como `N/D`.

`/positions`

- posiciones activas por símbolo
- side
- tamaño
- margen
- ROE
- PnL
- duración si existe en state
- TP/SL si Binance los expone

Si no hay posiciones:

```text
💼 POSICIONES ACTIVAS
• Ninguna
```

`/config`

Muestra configuración efectiva de Aegis Turbo:

- `REGIMES.AEGIS_TURBO.entry_threshold`
- leverage
- hard stop ROE
- TP ROE
- trailing activation/callback
- max hold
- `aegis.turbo.enabled`
- `aegis.turbo.live_enabled`
- allow short
- position fraction cap
- max trades per day
- max consecutive losses
- daily loss stop
- cooldown
- require brackets
- close if bracket fails

`/signal SYMBOL`

Consulta Aegis API para un símbolo sin ejecutar operaciones.

Muestra:

- raw action
- gated action
- Turbo score
- threshold efectivo del YAML para el símbolo
- votes
- reason formateado
- freshness
- feature timestamp
- production allowed
- execute/would execute reportado por Python

`/signals`

Consulta todos los símbolos activos. Si falla un símbolo, marca `ERROR` y continúa con los demás.

`/risk`

Muestra:

- trades today y límite
- consecutive losses y límite
- daily PnL y daily loss stop
- cooldown
- liquidity stress si está disponible
- require brackets
- close if bracket fails
- shorts enabled

`/brackets`

Solo lee órdenes abiertas de cierre por símbolo/posición.

Muestra:

- SL activo sí/no
- TP activo sí/no
- precios si están disponibles
- alerta si falta algún bracket

No recrea brackets.

`/report today`

Usa el analyzer local de Aegis Turbo sin shell externo. Lee `logs/aegis/*.jsonl` y responde resumen del día:

- trades
- cerrados
- win rate
- net PnL
- profit factor
- best/worst ROE
- símbolos operados

Si no hay datos:

```text
No hay trades registrados hoy.
```

## Implementación

Módulos:

- `src/app/telegram/TelegramCommandRouter.ts`
- `src/app/telegram/TelegramCommandHandlers.ts`
- `src/app/telegram/TelegramCommandTypes.ts`
- `src/infra/telegram/TelegramBotCommandListener.ts`

El listener se integra en `src/main.ts` solo cuando está activado por env y hay chats autorizados.
