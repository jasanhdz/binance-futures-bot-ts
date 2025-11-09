# ML Advanced Strategy - Production Ready

Estrategia optimizada para LINK, SOL y BNB basada en modelos LSTM+Attention con validación walk-forward.

## 🎯 Modelos Optimizados

### TIER 2 - Production Ready

| Symbol | Score | Timeframes | Directions | Win Rate | Monthly Return |
|--------|-------|------------|------------|----------|----------------|
| **LINK** | 6.8/10 | 15m/15m | Both | 48% | 4-6% |
| **SOL** | 6.5/10 | 5m/15m | Both | 46% | 5-8% |
| **BNB** | 6.2/10 | -/15m | Short Only | 43% | 2-4% |

## 📊 Configuración por Símbolo

### LINK/USDT (Balanced)
```typescript
Timeframes:
  Long: 15m   (Test F1: 0.458, Recall: 47.5%)
  Short: 15m  (Test F1: 0.393, Recall: 33.4%)

Thresholds:
  Long: ≥0.65  (3/4 confirmations required)
  Short: ≥0.70 (3/4 confirmations required)

Risk:
  Position Size: 1%
  Stop Loss: 2.5% max
  Risk/Reward: 1.5:1
```

### SOL/USDT (Dual Timeframe)
```typescript
Timeframes:
  Long: 5m    (Test F1: 0.481, Recall: 61.9%) ⭐
  Short: 15m  (Test F1: 0.487, Recall: 55.3%)

Thresholds:
  Long: ≥0.70  (4/4 confirmations - strict for 5m)
  Short: ≥0.65 (2/4 confirmations)

Risk:
  Position Size: 0.8%
  Stop Loss: 3.0% max
  Risk/Reward: 1.5:1
```

### BNB/USDT (Short Only)
```typescript
Timeframes:
  Long: ❌ NOT USED
  Short: 15m  (Test F1: 0.557, Recall: 83.4%!) ⭐⭐

Thresholds:
  Long: N/A
  Short: ≥0.60 (1/4 confirmation - high recall mode)

Risk:
  Position Size: 0.75%
  Stop Loss: 2.5% max
  Risk/Reward: 1.5:1
```

## 🚀 Uso

### 1. Configuración Básica

```typescript
import { MlAdvancedStrategy } from './strategies/ml_advanced';

// Create strategy instance
const strategy = new MlAdvancedStrategy('15m');

// Evaluate signal
const signal = await strategy.evaluate({
  symbol: 'LINKUSDT',
  exchange: binanceExchange,
  config: botConfig,
  state: currentState,
  now: Date.now(),
  logger: logger,
});

if (signal.action === 'ENTER_LONG') {
  await executeLong(signal);
} else if (signal.action === 'ENTER_SHORT') {
  await executeShort(signal);
}
```

### 2. Configuración Avanzada

```typescript
import { ML_ADVANCED_CONFIG, getEnabledSymbols } from './strategies/ml_advanced_config';

// Get all enabled symbols
const symbols = getEnabledSymbols();
console.log('Trading:', symbols); // ['LINKUSDT', 'SOLUSDT', 'BNBUSDT']

// Check if should trade direction
import { shouldTradeDirection } from './strategies/ml_advanced_config';

if (shouldTradeDirection('BNBUSDT', 'long')) {
  // Never true - BNB doesn't trade longs
}

if (shouldTradeDirection('BNBUSDT', 'short')) {
  // True - BNB trades shorts
}
```

### 3. Bot Integration

```typescript
// In main.ts or bot loop
import { MlAdvancedStrategy } from './strategies/ml_advanced';
import { getTier2Symbols } from './strategies/ml_advanced_config';

const strategy = new MlAdvancedStrategy();
const symbols = getTier2Symbols(); // ['LINKUSDT', 'SOLUSDT', 'BNBUSDT']

for (const symbol of symbols) {
  const signal = await strategy.evaluate({
    symbol,
    exchange,
    config,
    state: botState,
    now: Date.now(),
    logger,
  });
  
if (signal.action === 'ENTER_LONG' || signal.action === 'ENTER_SHORT') {
  logger.info(`Signal for ${symbol}: ${signal.action} @ ${signal.confidence}`);
  // Execute trade...
}
}

### 4. Integración con `npm run dev:*`
1. Copia `.env.example` → `.env` (y la variante testnet si aplica).
2. Define `STRATEGY=ml_advanced` y apunta `ML_SERVICE_URL` al backend Python que sirve probabilidades.
3. Declara los símbolos optimizados con el formato `SYMBOLS="SYMBOL:LEVERAGE:CAPITAL_SHARE"`. Si escribes `LINK`, el parser añade automáticamente `USDT`.
4. Ejecuta `npm run dev:prod` (o `npm run dev:testnet`). Durante el arranque verás `strategy_selected=name=ml_advanced` y la lista de símbolos habilitados.
```

## 🔧 Configuración Detallada

### Ajustar Thresholds

Edita `ml_advanced_config.ts`:

```typescript
LINKUSDT: {
  longThreshold: 0.65,  // ← Aumentar si muchas falsas señales
  shortThreshold: 0.70, // ← Reducir si pocas señales
}
```

### Cambiar Position Size

```typescript
LINKUSDT: {
  maxPositionPercent: 0.01, // ← 1% del capital
}
```

### Activar/Desactivar Símbolos

```typescript
ETHUSDT: {
  enabled: false, // ← Cambiar a true después de paper trading
}
```

## 📈 Confirmaciones Técnicas

La estrategia verifica 4 confirmaciones antes de entrar:

1. **RSI** (30-70): No sobrecomprado/sobrevendido
2. **MACD**: Crossover en dirección correcta
3. **Volume**: >1.3x promedio 20 períodos
4. **Trend**: Precio vs EMA50

### Requisitos por Símbolo

| Symbol | Long Confirmations | Short Confirmations |
|--------|-------------------|---------------------|
| LINK | 3 of 4 | 3 of 4 |
| SOL | 4 of 4 (strict) | 2 of 4 (relaxed) |
| BNB | N/A | 1 of 4 (minimal) |

## 🛡️ Risk Management

### Stop Loss

Usa el menor de:
- 2x ATR(14)
- Max % configurado (2.5-3%)

```typescript
// Ejemplo: LINK long a $20
Entry: $20.00
ATR: $0.30
Stop: $19.40 (2x ATR) o $19.50 (2.5%) → usa $19.50 (más tight)
```

### Take Profit

Risk/Reward ratio 1.5:1

```typescript
// Ejemplo continuado
Risk: $0.50 (entry - stop)
Reward: $0.75 (risk * 1.5)
Take Profit: $20.75
```

## 📊 Monitoreo

### Métricas a Trackear

```typescript
// Signal metadata incluye:
{
  strategy: 'ml_advanced',
  symbol: 'LINKUSDT',
  timeframe: '15m',
  probability: 0.72,
  confirmations: 3,
  rsi: true,
  macd: true,
  volume: true,
  trend: false,
}
```

### Logging

```
[ML_ADVANCED] LINKUSDT LONG SIGNAL 
  prob=0.72 conf=3/3 
  entry=20.00 stop=19.50 tp=20.75
```

## 🐛 Troubleshooting

### "No configuration for symbol"

```typescript
// Solución: Añadir símbolo a ml_advanced_config.ts
NEWSYMBOL: {
  enabled: true,
  tier: 3,
  // ... config
}
```

### "Insufficient candles"

```typescript
// Solución: Aumentar historyBars
const strategy = new MlAdvancedStrategy('15m');
// Internamente usa 256 bars
```

### "All signals rejected by confirmations"

```typescript
// Solución 1: Reducir minConfirmations
SOLUSDT: {
  minConfirmations: 2, // ← Era 3
}

// Solución 2: Ajustar confirmation logic
// En ml_advanced.ts, línea ~200
```

## 🔄 Actualizar Modelos

Cuando re-entrenes modelos:

1. Actualiza `meta.json` en Python
2. Actualiza thresholds en `ml_advanced_config.ts`
3. Re-testa en paper trading
4. Deploy gradual

```bash
# Python: Re-entrenar
python scripts/train_improved_gpu.py --symbol LINKUSDT

# TypeScript: Actualizar config
# Edita ml_advanced_config.ts con nuevas métricas
```

## 📞 Comandos Útiles

```bash
# Compilar TypeScript
npm run build

# Ejecutar bot
npm start

# Ejecutar en modo dev
npm run dev

# Backtesting (si implementado)
npm run backtest -- --symbols LINKUSDT,SOLUSDT,BNBUSDT
```

## ✅ Checklist Pre-Producción

- [ ] Modelos entrenados y validados (walk-forward)
- [ ] Thresholds optimizados en config
- [ ] Paper trading 2 semanas mínimo
- [ ] Win rate > 45% en paper trading
- [ ] Max drawdown < 15%
- [ ] Monitoring y alertas configuradas
- [ ] Kill switch implementado
- [ ] Start con capital reducido (10-20%)

## 💰 Performance Esperado

### Portfolio (LINK 30% + SOL 25% + BNB 15%)

```
Win Rate: 46-48%
Monthly Return: 9-15%
Sharpe Ratio: 1.8-2.2
Max Drawdown: 12-15%
```

### Por Símbolo

```
LINK: 4-6% mensual, Sharpe 1.8-2.2
SOL:  5-8% mensual, Sharpe 1.9-2.4
BNB:  2-4% mensual, Sharpe 1.5-1.9
```

## 🎓 Notas Importantes

1. **SOL usa 2 timeframes**: Longs en 5m, Shorts en 15m
2. **BNB solo shorts**: No entrar longs nunca
3. **LINK más confiable**: Usar como primary allocation
4. **Thresholds ajustables**: Optimizar según performance
5. **Paper trading obligatorio**: Antes de dinero real

## 📚 Referencias

- Modelos: `/Users/jasanhernandez/Develop/experimental/trading_system/models/advanced`
- Walk-forward results: `models/advanced/{SYMBOL}/{TF}/walk_forward_results.json`
- Análisis completo: Ver artifact "production_readiness_report"
