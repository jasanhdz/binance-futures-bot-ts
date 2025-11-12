/**
 * Example: Using ML Advanced Strategy
 * 
 * This file shows how to integrate the ML Advanced Strategy
 * into your trading bot.
 */

import { MlAdvancedStrategy } from './ml_advanced';
import { 
  ML_ADVANCED_CONFIG, 
  getEnabledSymbols, 
  getTier2Symbols,
  getSymbolMaxRisk,
  shouldTradeDirection 
} from './ml_advanced_config';
import type { BotState } from '../core/types';
import { CONFIG } from '../infra/config';
import type { BotConfig } from '../infra/config';

type ExamplePosition = {
  symbol: string;
  side: 'long' | 'short';
  entry: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  confidence?: number;
  timestamp: number;
};

// ============================================================================
// EXAMPLE 1: Basic Usage
// ============================================================================

export async function example1_basicUsage(exchange: any, logger: any) {
  const strategy = new MlAdvancedStrategy('15m');
  const config: BotConfig = CONFIG;
  const botState: BotState = { mode: 'IDLE' };
  
  const signal = await strategy.evaluate({
    symbol: 'LINKUSDT',
    exchange,
    config,
    state: botState,
    now: Date.now(),
    logger,
  });
  
  logger.info(`Signal: ${signal.action}`);
  
  if (signal.action === 'ENTER_LONG') {
    logger.info(`Entry: current price`);
    logger.info(`Stop Loss: ${signal.stopLoss}`);
    logger.info(`Take Profit: ${signal.takeProfit}`);
    logger.info(`Confidence: ${signal.confidence}`);
  }
}

// ============================================================================
// EXAMPLE 2: Multiple Symbols
// ============================================================================

export async function example2_multipleSymbols(exchange: any, logger: any) {
  const strategy = new MlAdvancedStrategy();
  const symbols = getTier2Symbols(); // ['LINKUSDT', 'SOLUSDT', 'BNBUSDT']
  const config: BotConfig = CONFIG;
  const botState: BotState = { mode: 'IDLE' };
  
  logger.info(`Scanning ${symbols.length} symbols...`);
  
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
      const displaySide = signal.action === 'ENTER_LONG' ? 'LONG' : 'SHORT';
      logger.success(
        `🎯 ${symbol}: ${displaySide} @ ${signal.confidence?.toFixed(2)}`
      );
    }
  }
}

// ============================================================================
// EXAMPLE 3: With Position Sizing
// ============================================================================

export async function example3_withPositionSizing(exchange: any, logger: any) {
  const strategy = new MlAdvancedStrategy();
  const balance = 10000; // $10,000
  const config: BotConfig = CONFIG;
  const botState: BotState = { mode: 'IDLE' };
  
  const symbol = 'LINKUSDT';
  const signal = await strategy.evaluate({
    symbol,
    exchange,
    config,
    state: botState,
    now: Date.now(),
    logger,
  });
  
  if (signal.action === 'ENTER_LONG' || signal.action === 'ENTER_SHORT') {
    const displaySide = signal.action === 'ENTER_LONG' ? 'LONG' : 'SHORT';
    // Get max risk for symbol
    const maxRiskPercent = getSymbolMaxRisk(symbol);
    const positionSize = balance * maxRiskPercent;
    
    // Get current price
    const ticker = await exchange.fetchTicker(symbol);
    const currentPrice = ticker.last;
    
    // Calculate quantity
    const quantity = positionSize / currentPrice;
    
    logger.info(`Position Details:`);
    logger.info(`  Balance: $${balance}`);
    logger.info(`  Max Risk: ${(maxRiskPercent * 100).toFixed(2)}%`);
    logger.info(`  Position Size: $${positionSize}`);
    logger.info(`  Price: $${currentPrice}`);
    logger.info(`  Quantity: ${quantity.toFixed(4)}`);
    logger.info(`  Stop Loss: $${signal.stopLoss}`);
    logger.info(`  Take Profit: $${signal.takeProfit}`);
    
    // Execute trade
    // await exchange.createOrder(symbol, 'market', displaySide === 'LONG' ? 'buy' : 'sell', quantity);
  }
}

// ============================================================================
// EXAMPLE 4: Full Trading Loop
// ============================================================================

export async function example4_fullTradingLoop(exchange: any, logger: any) {
  const strategy = new MlAdvancedStrategy();
  const symbols = getTier2Symbols();
  const config: BotConfig = CONFIG;
  const botState: BotState = { mode: 'IDLE' };
  
  const balance = 10000;
  const positions: ExamplePosition[] = [];
  
  // Main trading loop
  while (true) {
    try {
      for (const symbol of symbols) {
        // Skip if already have position
        if (positions.find(p => p.symbol === symbol)) {
          continue;
        }
        
        // Get signal
        const signal = await strategy.evaluate({
          symbol,
          exchange,
          config,
          state: botState,
          now: Date.now(),
          logger,
        });
        
        // Execute if signal
        if (signal.action === 'ENTER_LONG' || signal.action === 'ENTER_SHORT') {
          const isLongSignal = signal.action === 'ENTER_LONG';
          const displaySide = isLongSignal ? 'LONG' : 'SHORT';
          const orderSide = isLongSignal ? 'buy' : 'sell';
          const exitSide = isLongSignal ? 'sell' : 'buy';
          if (signal.stopLoss === undefined || signal.takeProfit === undefined) {
            logger.warn(`${symbol}: Missing stopLoss/takeProfit, skipping order`);
            continue;
          }
          const stopLoss = signal.stopLoss;
          const takeProfit = signal.takeProfit;
          const positionSide: 'long' | 'short' = isLongSignal ? 'long' : 'short';
          const maxRisk = getSymbolMaxRisk(symbol);
          const positionSize = balance * maxRisk;
          
          // Get price
          const ticker = await exchange.fetchTicker(symbol);
          const price = ticker.last;
          const quantity = positionSize / price;
          
          logger.success(`📈 Opening ${displaySide} on ${symbol} @ $${price}`);
          
          // Create order
          const order = await exchange.createOrder(symbol, 'market', orderSide, quantity);
          
          // Set stop loss & take profit
          await exchange.createOrder(symbol, 'stop_market', exitSide, quantity, stopLoss);
          await exchange.createOrder(symbol, 'limit', exitSide, quantity, takeProfit);
          
          // Track position
          positions.push({
            symbol,
            side: positionSide,
            entry: price,
            quantity,
            stopLoss,
            takeProfit,
            confidence: signal.confidence,
            timestamp: Date.now(),
          });
          botState.mode = isLongSignal ? 'LONG_RIDE' : 'SHORT_RIDE';
          botState.lastSide = isLongSignal ? 'LONG' : 'SHORT';
          botState.lastEntryPrice = price;
          botState.lastEntryAt = Date.now();
          
          logger.info(`Position opened successfully`);
        }
      }
      
      // Check existing positions
      for (const position of positions) {
        const ticker = await exchange.fetchTicker(position.symbol);
        const currentPrice = ticker.last;
        
        // Check if stop or TP hit
        if (position.side === 'long') {
          if (currentPrice <= position.stopLoss) {
            logger.warn(`❌ ${position.symbol} Stop Loss hit`);
            // Close position...
            botState.mode = 'IDLE';
            botState.lastExitReason = 'stop_loss';
            botState.lastExitAt = Date.now();
          } else if (currentPrice >= position.takeProfit) {
            logger.success(`✅ ${position.symbol} Take Profit hit`);
            // Close position...
            botState.mode = 'IDLE';
            botState.lastExitReason = 'take_profit';
            botState.lastExitAt = Date.now();
          }
        } else {
          if (currentPrice >= position.stopLoss) {
            logger.warn(`❌ ${position.symbol} Stop Loss hit`);
            // Close position...
            botState.mode = 'IDLE';
            botState.lastExitReason = 'stop_loss';
            botState.lastExitAt = Date.now();
          } else if (currentPrice <= position.takeProfit) {
            logger.success(`✅ ${position.symbol} Take Profit hit`);
            // Close position...
            botState.mode = 'IDLE';
            botState.lastExitReason = 'take_profit';
            botState.lastExitAt = Date.now();
          }
        }
      }
      
      // Wait before next iteration
      await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute
      
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`Error in trading loop: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds
    }
  }
}

// ============================================================================
// EXAMPLE 5: Checking Symbol Configuration
// ============================================================================

export function example5_checkConfiguration() {
  console.log('='.repeat(80));
  console.log('ML ADVANCED STRATEGY CONFIGURATION');
  console.log('='.repeat(80));
  console.log();
  
  const symbols = getEnabledSymbols();
  
  for (const symbol of symbols) {
    const config = ML_ADVANCED_CONFIG.symbols[symbol];
    
    console.log(`${symbol}:`);
    console.log(`  Tier: ${config.tier}`);
    console.log(`  Score: ${config.score}/10`);
    console.log(`  Enabled: ${config.enabled}`);
    console.log();
    
    console.log(`  Timeframes:`);
    console.log(`    Long: ${config.longTimeframe || 'N/A'}`);
    console.log(`    Short: ${config.shortTimeframe || 'N/A'}`);
    console.log();
    
    console.log(`  Thresholds:`);
    console.log(`    Long: ${config.longThreshold || 'N/A'}`);
    console.log(`    Short: ${config.shortThreshold || 'N/A'}`);
    console.log();
    
    console.log(`  Risk:`);
    console.log(`    Max Position: ${(config.maxPositionPercent * 100).toFixed(2)}%`);
    console.log(`    Max Stop Loss: ${(config.maxStopLossPercent * 100).toFixed(2)}%`);
    console.log(`    Risk/Reward: ${config.riskRewardRatio}:1`);
    console.log();
    
    console.log(`  Expected Performance:`);
    console.log(`    Win Rate: ${(config.expectedWinRate * 100).toFixed(0)}%`);
    console.log(`    Monthly Return: ${(config.expectedMonthlyReturn * 100).toFixed(0)}%`);
    console.log(`    Max Drawdown: ${(config.maxDrawdown * 100).toFixed(0)}%`);
    console.log();
    
    console.log(`  Trading Directions:`);
    console.log(`    Longs: ${shouldTradeDirection(symbol, 'long') ? 'YES' : 'NO'}`);
    console.log(`    Shorts: ${shouldTradeDirection(symbol, 'short') ? 'YES' : 'NO'}`);
    console.log();
    console.log('-'.repeat(80));
    console.log();
  }
}

// ============================================================================
// RUN EXAMPLES
// ============================================================================

// Uncomment to run
// example5_checkConfiguration();
