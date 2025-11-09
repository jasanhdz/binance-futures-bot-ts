/**
 * ML Advanced Strategy Configuration
 * 
 * Centralized configuration for LINK, SOL, BNB models
 * Based on walk-forward validation results
 */

export interface MLAdvancedConfig {
  // Model paths
  modelBasePath: string;
  
  // Symbol-specific settings
  symbols: {
    [symbol: string]: {
      enabled: boolean;
      tier: 1 | 2 | 3 | 4;
      score: number;
      
      // Timeframes (null = don't use)
      longTimeframe: string | null;
      shortTimeframe: string | null;
      
      // Confidence thresholds
      longThreshold: number | null;
      shortThreshold: number | null;
      
      // Position sizing
      maxPositionPercent: number;
      
      // Risk management
      maxStopLossPercent: number;
      riskRewardRatio: number;
      
      // Technical confirmations
      requireConfirmations: boolean;
      minConfirmations: number;
      
      // Performance metrics (for monitoring)
      expectedWinRate: number;
      expectedMonthlyReturn: number;
      maxDrawdown: number;
    };
  };
  
  // Global settings
  global: {
    // Risk limits
    maxTotalExposure: number;
    maxPositionsPerSymbol: number;
    
    // Monitoring
    enablePerformanceTracking: boolean;
    alertOnLowPerformance: boolean;
    
    // Fallback
    fallbackToHold: boolean;
  };
}

export const ML_ADVANCED_CONFIG: MLAdvancedConfig = {
  modelBasePath: '/Users/jasanhernandez/Develop/experimental/trading_system/models/advanced',
  
  symbols: {
    LINKUSDT: {
      enabled: true,
      tier: 2,
      score: 6.8,
      
      // Best timeframe: 15m for both directions
      longTimeframe: '15m',
      shortTimeframe: '15m',
      
      // Optimized thresholds
      // longThreshold: 0.65,
      // shortThreshold: 0.70,
      longThreshold: 0.55,
      shortThreshold: 0.60,
      
      // Position sizing (1% max)
      maxPositionPercent: 0.01,
      
      // Risk management
      maxStopLossPercent: 0.025, // 2.5%
      riskRewardRatio: 1.5,
      
      // Technical confirmations (3 of 4 required)
      requireConfirmations: true,
      minConfirmations: 3,
      
      // Expected performance
      expectedWinRate: 0.48,
      expectedMonthlyReturn: 0.05, // 5%
      maxDrawdown: 0.12,
    },
    
    SOLUSDT: {
      enabled: true,
      tier: 2,
      score: 6.5,
      
      // Dual timeframe: 5m for longs, 15m for shorts
      longTimeframe: '5m',
      shortTimeframe: '15m',
      
      // Different thresholds per direction
      longThreshold: 0.70, // Higher (5m needs more confidence)
      shortThreshold: 0.65,
      
      // Position sizing (0.8% - more volatile)
      maxPositionPercent: 0.008,
      
      // Risk management
      maxStopLossPercent: 0.030, // 3% (higher volatility)
      riskRewardRatio: 1.5,
      
      // Technical confirmations
      // 4/4 for longs (5m risky), 2/4 for shorts (15m solid)
      requireConfirmations: true,
      minConfirmations: 2, // Applied differently per direction in code
      
      // Expected performance
      expectedWinRate: 0.46,
      expectedMonthlyReturn: 0.06, // 6%
      maxDrawdown: 0.15,
    },
    
    BNBUSDT: {
      enabled: true,
      tier: 2,
      score: 6.2,
      
      // SHORT ONLY specialist
      longTimeframe: null, // DO NOT USE
      shortTimeframe: '15m',
      
      // Thresholds
      longThreshold: null,
      shortThreshold: 0.60, // Lower threshold (83% recall!)
      
      // Position sizing (0.75%)
      maxPositionPercent: 0.0075,
      
      // Risk management
      maxStopLossPercent: 0.025,
      riskRewardRatio: 1.5,
      
      // Technical confirmations (minimal)
      requireConfirmations: true,
      minConfirmations: 1, // Just basic confirmation
      
      // Expected performance
      expectedWinRate: 0.43,
      expectedMonthlyReturn: 0.03, // 3%
      maxDrawdown: 0.12,
    },
    
    // TIER 3 - Paper trading only (disabled by default)
    ETHUSDT: {
      enabled: false, // Enable after paper trading
      tier: 3,
      score: 6.0,
      
      longTimeframe: '15m',
      shortTimeframe: '15m',
      
      longThreshold: 0.70,
      shortThreshold: 0.75,
      
      maxPositionPercent: 0.005, // 0.5% (conservative)
      
      maxStopLossPercent: 0.020,
      riskRewardRatio: 1.5,
      
      requireConfirmations: true,
      minConfirmations: 3,
      
      expectedWinRate: 0.42,
      expectedMonthlyReturn: 0.04,
      maxDrawdown: 0.12,
    },
    
    XRPUSDT: {
      enabled: false, // Enable after paper trading
      tier: 3,
      score: 5.8,
      
      longTimeframe: '15m',
      shortTimeframe: null, // Shorts weak
      
      longThreshold: 0.75,
      shortThreshold: null,
      
      maxPositionPercent: 0.005,
      
      maxStopLossPercent: 0.020,
      riskRewardRatio: 1.5,
      
      requireConfirmations: true,
      minConfirmations: 3,
      
      expectedWinRate: 0.40,
      expectedMonthlyReturn: 0.03,
      maxDrawdown: 0.10,
    },
  },
  
  global: {
    // Risk limits
    maxTotalExposure: 0.70, // Max 70% of capital in positions
    maxPositionsPerSymbol: 1,
    
    // Monitoring
    enablePerformanceTracking: true,
    alertOnLowPerformance: true,
    
    // Fallback
    fallbackToHold: true,
  },
};

// Helper functions
export function getEnabledSymbols(): string[] {
  return Object.entries(ML_ADVANCED_CONFIG.symbols)
    .filter(([_, config]) => config.enabled)
    .map(([symbol]) => symbol);
}

export function getTier2Symbols(): string[] {
  return Object.entries(ML_ADVANCED_CONFIG.symbols)
    .filter(([_, config]) => config.enabled && config.tier === 2)
    .map(([symbol]) => symbol);
}

export function getSymbolTimeframes(symbol: string): string[] {
  const config = ML_ADVANCED_CONFIG.symbols[symbol];
  if (!config) return [];
  
  const timeframes: string[] = [];
  if (config.longTimeframe) timeframes.push(config.longTimeframe);
  if (config.shortTimeframe && config.shortTimeframe !== config.longTimeframe) {
    timeframes.push(config.shortTimeframe);
  }
  
  return timeframes;
}

export function getSymbolMaxRisk(symbol: string): number {
  const config = ML_ADVANCED_CONFIG.symbols[symbol];
  return config?.maxPositionPercent ?? 0.005; // Default 0.5%
}

export function shouldTradeDirection(symbol: string, direction: 'long' | 'short'): boolean {
  const config = ML_ADVANCED_CONFIG.symbols[symbol];
  if (!config) return false;
  
  if (direction === 'long') {
    return config.longTimeframe !== null && config.longThreshold !== null;
  } else {
    return config.shortTimeframe !== null && config.shortThreshold !== null;
  }
}
