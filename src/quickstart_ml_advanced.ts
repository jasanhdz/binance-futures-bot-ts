/**
 * QUICK START - ML Advanced Strategy
 * 
 * Copy this file to your main trading loop to get started quickly
 */

import { MlAdvancedStrategy } from './strategies/ml_advanced';
import { getTier2Symbols, getSymbolMaxRisk } from './strategies/ml_advanced_config';

// ============================================================================
// QUICK START EXAMPLE
// ============================================================================

export async function quickStartMLAdvanced(
  exchange: any,  // Your Binance exchange instance
  logger: any,    // Your logger
  balance: number = 10000 // Starting balance
) {
  
  logger.info('🚀 Starting ML Advanced Strategy');
  logger.info('=' .repeat(80));
  
  // 1. Initialize strategy
  const strategy = new MlAdvancedStrategy('15m');
  
  // 2. Get enabled symbols
  const symbols = getTier2Symbols();
  logger.info(`Trading symbols: ${symbols.join(', ')}`);
  logger.info('');
  
  // 3. Trading state
  const positions: any[] = [];
  
  // 4. Main loop
  while (true) {
    try {
      const startTime = Date.now();
      
      // Scan each symbol
      for (const symbol of symbols) {
        // Skip if already have position
        if (positions.find(p => p.symbol === symbol)) {
          logger.debug(`${symbol}: Position already open, skipping`);
          continue;
        }
        
        // Get signal
        logger.info(`${symbol}: Evaluating...`);
        const signal = await strategy.evaluate({
          symbol,
          exchange,
          config: {}, // Your bot config
          state: { positions, balance },
          now: Date.now(),
          logger,
        });
        
        const isEntrySignal =
          signal.action === 'ENTER_LONG' || signal.action === 'ENTER_SHORT';
        if (isEntrySignal) {
          const isLongSignal = signal.action === 'ENTER_LONG';
          const displaySide = isLongSignal ? 'LONG' : 'SHORT';
          const orderSide = isLongSignal ? 'buy' : 'sell';
          const exitSide = isLongSignal ? 'sell' : 'buy';

          logger.success('');
          logger.success(`🎯 ${symbol}: ${displaySide} SIGNAL`);
          logger.success(`   Confidence: ${signal.confidence?.toFixed(2)}`);
          logger.success(`   Stop Loss: ${signal.stopLoss?.toFixed(4)}`);
          logger.success(`   Take Profit: ${signal.takeProfit?.toFixed(4)}`);
          
          // Get current price
          const ticker = await exchange.fetchTicker(symbol);
          const currentPrice = ticker.last;
          
          // Calculate position size
          const maxRisk = getSymbolMaxRisk(symbol);
          const positionValue = balance * maxRisk;
          const quantity = positionValue / currentPrice;
          
          logger.info(`   Position Size: $${positionValue.toFixed(2)} (${(maxRisk * 100).toFixed(2)}%)`);
          logger.info(`   Quantity: ${quantity.toFixed(4)}`);
          logger.info('');
          
          // ⚠️ UNCOMMENT TO ENABLE LIVE TRADING ⚠️
          /*
          // Open position
          const order = await exchange.createOrder(
            symbol,
            'market',
            orderSide,
            quantity
          );
          
          logger.success(`✅ Position opened: ${order.id}`);
          
          // Set stop loss
          await exchange.createOrder(
            symbol,
            'stop_market',
            exitSide,
            quantity,
            signal.stopLoss
          );
          
          // Set take profit
          await exchange.createOrder(
            symbol,
            'limit',
            exitSide,
            quantity,
            signal.takeProfit
          );
          
          // Track position
          positions.push({
            symbol,
            side: displaySide.toLowerCase(),
            entry: currentPrice,
            quantity,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            timestamp: Date.now(),
            metadata: signal.metadata,
          });
          */
          
          // Paper trading: just log
          logger.warn('⚠️  PAPER TRADING MODE - No real orders placed');
          positions.push({
            symbol,
            side: displaySide.toLowerCase(),
            entry: currentPrice,
            quantity,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            timestamp: Date.now(),
            metadata: signal.metadata,
            paperTrading: true,
          });
          
        } else {
          logger.debug(`${symbol}: IDLE (no signal)`);
        }
      }
      
      // Check existing positions
      if (positions.length > 0) {
        logger.info('');
        logger.info('📊 Position Status:');
        
        for (const position of positions) {
          const ticker = await exchange.fetchTicker(position.symbol);
          const currentPrice = ticker.last;
          
          const pnl = position.side === 'long'
            ? ((currentPrice - position.entry) / position.entry) * 100
            : ((position.entry - currentPrice) / position.entry) * 100;
          
          const pnlColor = pnl >= 0 ? '🟢' : '🔴';
          logger.info(`   ${position.symbol} ${position.side.toUpperCase()}: ${pnlColor} ${pnl.toFixed(2)}%`);
          
          // Check if stop or TP hit
          if (position.side === 'long') {
            if (currentPrice <= position.stopLoss) {
              logger.warn(`   ❌ ${position.symbol} STOP LOSS HIT`);
              // Remove from positions
              const index = positions.indexOf(position);
              positions.splice(index, 1);
            } else if (currentPrice >= position.takeProfit) {
              logger.success(`   ✅ ${position.symbol} TAKE PROFIT HIT`);
              // Remove from positions
              const index = positions.indexOf(position);
              positions.splice(index, 1);
            }
          } else {
            if (currentPrice >= position.stopLoss) {
              logger.warn(`   ❌ ${position.symbol} STOP LOSS HIT`);
              const index = positions.indexOf(position);
              positions.splice(index, 1);
            } else if (currentPrice <= position.takeProfit) {
              logger.success(`   ✅ ${position.symbol} TAKE PROFIT HIT`);
              const index = positions.indexOf(position);
              positions.splice(index, 1);
            }
          }
        }
      }
      
      // Loop timing
      const elapsed = Date.now() - startTime;
      logger.info('');
      logger.info(`Loop completed in ${(elapsed / 1000).toFixed(1)}s`);
      logger.info(`Next scan in 60 seconds...`);
      logger.info('=' .repeat(80));
      
      // Wait before next iteration
      await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute
      
    } catch (error) {
      logger.error(`❌ Error in trading loop: ${error}`);
      logger.error(error.stack);
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds
    }
  }
}

// ============================================================================
// HOW TO USE
// ============================================================================

/*

1. Import in your main.ts:
   
   import { quickStartMLAdvanced } from './quickstart_ml_advanced';

2. Call it with your exchange and logger:
   
   await quickStartMLAdvanced(binanceExchange, logger, 10000);

3. Initially runs in PAPER TRADING mode

4. To enable live trading:
   
   - Uncomment the section marked "UNCOMMENT TO ENABLE LIVE TRADING"
   - Make sure you've done paper trading for 2+ weeks first
   - Start with small balance (10-20% of capital)

5. Monitor performance:
   
   - Track win rate (should be >45%)
   - Track max drawdown (should be <15%)
   - Adjust thresholds in ml_advanced_config.ts if needed

6. Scale up:
   
   - Week 1: $500-1000
   - Week 2: $2000-3000 (if performance good)
   - Week 3: $5000-10000 (if still good)
   - Month 2+: Full allocation

*/
