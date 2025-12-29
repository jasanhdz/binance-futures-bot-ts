import fs from 'fs';
import path from 'path';

export interface TimeframeConfig {
    threshold: number;
    leverage?: number;
    avgSpread?: number; // Spread típico para cálculo de volatilidad (Ninja Protocol v2.0)
    pnl: number;
    trades: number;
    sharpe: number;
}

export interface SymbolConfig {
    [timeframe: string]: TimeframeConfig;
}

export interface MlConfig {
    [symbol: string]: SymbolConfig;
}

export class MlConfigWatcher {
    private static instance: MlConfigWatcher;
    private configPath: string;
    private config: MlConfig = {};
    private lastReload: number = 0;

    private constructor() {
        // Path to thresholds_config.json (absolute from project root)
        const projectRoot = path.resolve(__dirname, '../../..');
        this.configPath = path.join(projectRoot, 'models', 'advanced', 'thresholds_config.json');

        console.log(`[MlConfigWatcher] Watching config at: ${this.configPath}`);
        this.loadConfig();

        try {
            fs.watchFile(this.configPath, (curr, prev) => {
                if (curr.mtimeMs !== prev.mtimeMs) {
                    console.log('[MlConfigWatcher] Config file changed, reloading...');
                    this.loadConfig();
                }
            });
        } catch (e) {
            console.error('[MlConfigWatcher] Failed to setup file watcher:', e);
        }
    }

    public static getInstance(): MlConfigWatcher {
        if (!MlConfigWatcher.instance) {
            MlConfigWatcher.instance = new MlConfigWatcher();
        }
        return MlConfigWatcher.instance;
    }

    private loadConfig() {
        try {
            if (!fs.existsSync(this.configPath)) {
                console.warn(`[MlConfigWatcher] Config file not found at ${this.configPath}`);
                return;
            }

            const raw = fs.readFileSync(this.configPath, 'utf-8');
            this.config = JSON.parse(raw);
            this.lastReload = Date.now();
            console.log(`[MlConfigWatcher] Loaded config for ${Object.keys(this.config).length} symbols`);
        } catch (e) {
            console.error('[MlConfigWatcher] Failed to load config:', e);
        }
    }

    private getCleanSymbol(symbol: string): string {
        return symbol.replace('/', '').replace(':', '').toUpperCase();
    }

    public getThreshold(symbol: string, timeframe: string): number {
        const cleanSymbol = this.getCleanSymbol(symbol);
        return this.config[cleanSymbol]?.[timeframe]?.threshold ?? 0.99;
    }

    public getLeverage(symbol: string, timeframe: string): number {
        const cleanSymbol = this.getCleanSymbol(symbol);
        return this.config[cleanSymbol]?.[timeframe]?.leverage ?? 5; // Default safe leverage
    }

    public getConfig(symbol: string, timeframe: string): TimeframeConfig | null {
        const cleanSymbol = this.getCleanSymbol(symbol);
        return this.config[cleanSymbol]?.[timeframe] || null;
    }

    // Ninja Protocol v2.0: Average spread for volatility calculation
    // Lee exclusivamente del JSON, si no existe usa fallback genérico
    public getAvgSpread(symbol: string, timeframe: string = '15m'): number {
        const cleanSymbol = this.getCleanSymbol(symbol);
        const configuredSpread = this.config[cleanSymbol]?.[timeframe]?.avgSpread;

        if (configuredSpread === undefined) {
            // Log para detectar símbolos sin configurar
            console.warn(`[MlConfigWatcher] avgSpread not configured for ${cleanSymbol}/${timeframe}, using generic fallback`);
        }

        // Fallback genérico si no está en el JSON
        return configuredSpread ?? 0.0004;
    }
}
