import { MlProbabilityServiceClient, MlProbabilityResponse, MlProbabilityClientOptions } from '../../infra/adapters/PhantomMLAdapter';
import { Candle } from '../../domain/types';

export class BacktestMLAdapter extends MlProbabilityServiceClient {

    constructor(opts: MlProbabilityClientOptions = {}) {
        // Point to Backtest ML Service (port 8002)
        const backtestOpts = {
            ...opts,
            baseUrl: opts.baseUrl || 'http://127.0.0.1:8002'
        };
        super(backtestOpts);
    }

    async fetchProbabilities(params: {
        symbol: string;
        candles?: Candle[];
        btcCandles?: Candle[];
        precalculated_features?: any;
    }): Promise<MlProbabilityResponse> {
        const { symbol } = params;

        // Construct payload with custom candles
        const payload: any = { symbol };

        if (params.candles && params.candles.length > 0) {
            payload.custom_candles = params.candles.map(c => ({
                timestamp: c.timestamp,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume
            }));
        }

        if (params.btcCandles && params.btcCandles.length > 0) {
            payload.custom_btc_candles = params.btcCandles.map(c => ({
                timestamp: c.timestamp,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume
            }));
        }

        if (params.precalculated_features) {
            payload.precalculated_features = params.precalculated_features;
        }

        try {
            // Call the backtest endpoint
            const { data } = await this.http.post<MlProbabilityResponse>(
                '/ml-v2/backtest_predict',
                payload,
            );

            return {
                ...data,
                primary_timeframe: '1m',
                probabilities: {
                    '1m': { long_prob: data.long_prob, short_prob: data.short_prob }
                }
            };

        } catch (err) {
            // Fallback to parent error handling logic if needed, or just throw
            throw err;
        }
    }
}
