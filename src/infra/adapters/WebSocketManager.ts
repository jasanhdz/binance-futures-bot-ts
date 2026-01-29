
import { Binance, Candle } from 'binance-api-node';
import { Logger } from '../../app/ports/Logger';

export interface WebSocketConfig {
    reconnectIntervalMs?: number; // Proactive reset (e.g. 12h)
    watchdogTimeoutMs?: number;   // Heartbeat timeout (e.g. 60s)
    maxRetries?: number;
}

export class WebSocketManager {
    private activeCleanups: Record<string, () => void> = {};
    private activeSubscriptions: Record<string, { type: 'candle' | 'user', params: any }> = {};
    private lastHeartbeat: Record<string, number> = {};
    private watchdogTimer: NodeJS.Timeout | null = null;
    private resetTimer: NodeJS.Timeout | null = null;
    private isReconnecting = false;

    constructor(
        private client: Binance,
        private logger: Logger,
        private config: WebSocketConfig = {}
    ) {
        // Defaults
        this.config.reconnectIntervalMs = this.config.reconnectIntervalMs ?? 12 * 60 * 60 * 1000; // 12h
        this.config.watchdogTimeoutMs = this.config.watchdogTimeoutMs ?? 60 * 1000; // 60s
        this.config.maxRetries = this.config.maxRetries ?? 10;

        this.startWatchdog();
        this.startProactiveReset();
    }

    /**
     * Subscribe to Candle Stream
     */
    public connectCandles(symbol: string, interval: string, callback: (candle: Candle) => void) {
        const key = `candle:${symbol}:${interval}`;

        // Store subscription for recovery
        this.activeSubscriptions[key] = {
            type: 'candle',
            params: { symbol, interval, callback }
        };

        this.subscribeCandles(key, symbol, interval, callback);
    }

    private subscribeCandles(key: string, symbol: string, interval: string, callback: (candle: Candle) => void) {
        this.logger.info('🔌 WS Connecting', { key });

        try {
            const clean = this.client.ws.futuresCandles(symbol, interval, (candle) => {
                // this.logger.info('⚡ WS Tick', { key, price: candle.close });
                this.lastHeartbeat[key] = Date.now();
                callback(candle);
            });

            this.activeCleanups[key] = clean;
            this.lastHeartbeat[key] = Date.now(); // Init heartbeat

        } catch (e) {
            this.logger.error('WS Connection Failed', { key, error: String(e) });
            this.scheduleReconnect();
        }
    }

    /**
     * Subscribe to User Data Stream
     */
    public connectUserData(callback: (data: any) => void) {
        const key = 'user_data';

        this.activeSubscriptions[key] = {
            type: 'user',
            params: { callback }
        };

        this.subscribeUserData(key, callback);
    }

    private async subscribeUserData(key: string, callback: (data: any) => void) {
        this.logger.info('🔌 WS Connecting User Data');

        try {
            // futuresUser returns a Promise<ReconnectingWebSocketHandler>
            const clean = await this.client.ws.futuresUser((data) => {
                this.lastHeartbeat[key] = Date.now();
                callback(data);
            });

            this.activeCleanups[key] = clean;
            this.lastHeartbeat[key] = Date.now();

        } catch (e) {
            this.logger.error('WS User Connection Failed', { error: String(e) });
            this.scheduleReconnect();
        }
    }

    /**
     * Watchdog: Checks if any stream has frozen
     */
    private startWatchdog() {
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);

        this.watchdogTimer = setInterval(() => {
            if (this.isReconnecting) return;

            const now = Date.now();
            const timeout = this.config.watchdogTimeoutMs!;
            let needsReset = false;

            for (const [key, lastTime] of Object.entries(this.lastHeartbeat)) {
                if (now - lastTime > timeout) {
                    this.logger.warn('🚨 WS Watchdog Timeout', { key, elapsed: now - lastTime });
                    needsReset = true;
                }
            }

            if (needsReset) {
                this.logger.warn('🔥 Phoenix Protocol: Force Reconnecting all streams...');
                this.reconnectAll();
            }

        }, 5000); // Check every 5s
    }

    /**
     * Proactive Reset: Avoids 24h hard limit
     */
    private startProactiveReset() {
        if (this.resetTimer) clearInterval(this.resetTimer);

        this.resetTimer = setInterval(() => {
            this.logger.info('♻️ Proactive WS Reset (12h cycle)');
            this.reconnectAll();
        }, this.config.reconnectIntervalMs);
    }

    /**
     * Reconnect Logic
     */
    private async reconnectAll() {
        if (this.isReconnecting) return;
        this.isReconnecting = true;

        // 1. Disconnect all
        this.disconnectAll(false); // Don't clear subscriptions

        // 2. Wait a bit
        await new Promise(r => setTimeout(r, 2000));

        // 3. Re-subscribe
        this.logger.info('🔄 Re-subscribing to channels...', { count: Object.keys(this.activeSubscriptions).length });

        for (const [key, sub] of Object.entries(this.activeSubscriptions)) {
            if (sub.type === 'candle') {
                this.subscribeCandles(key, sub.params.symbol, sub.params.interval, sub.params.callback);
            } else if (sub.type === 'user') {
                this.subscribeUserData(key, sub.params.callback);
            }
        }

        this.isReconnecting = false;
        this.logger.info('✅ Phoenix Reconnection Complete');
    }

    private scheduleReconnect() {
        if (this.isReconnecting) return;
        setTimeout(() => this.reconnectAll(), 5000);
    }

    public disconnectAll(clearSubs = true) {
        for (const [key, clean] of Object.entries(this.activeCleanups)) {
            try {
                clean(); // Close socket
            } catch (e) {
                // Ignore close errors
            }
        }
        this.activeCleanups = {};
        this.lastHeartbeat = {};

        if (clearSubs) {
            this.activeSubscriptions = {};
        }
    }

    /**
     * 🧪 CHAOS TESTING: Simulate Network Failure
     */
    public simulateChaos(durationMs: number) {
        this.logger.warn(`🧪 CHAOS: Simulating Network Failure for ${durationMs}ms...`);

        // 1. Force Disconnect
        this.disconnectAll(false); // Keep subs to verify recovery

        // 2. Block Reconnection
        this.isReconnecting = true; // Fake "reconnecting" state to block watchdog/retries

        // 3. Schedule Recovery
        setTimeout(() => {
            this.logger.warn('🧪 CHAOS: Network Restored! Allowing recovery...');
            this.isReconnecting = false;
            this.reconnectAll();
        }, durationMs);
    }
}
