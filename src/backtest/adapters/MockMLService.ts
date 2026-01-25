import axios from 'axios';
import { MLService } from '../../app/ports/MLService';
import { PhantomSignal } from '../../domain/services/PhantomStrategy';
import { Exchange } from '../../app/ports/Exchange';

export class MockMLService implements MLService {
    private inferenceUrl = 'http://localhost:5000/predict';

    constructor(private exchange: Exchange) { }

    async getSignal(symbol: string): Promise<PhantomSignal> {
        try {
            const candle = await this.exchange.getLastCandle(symbol);
            if (!candle) {
                return {
                    symbol,
                    action: 'PASS',
                    confidence: 0,
                    longProb: 0,
                    shortProb: 0,
                    neutralProb: 1
                };
            }

            const response = await axios.post(this.inferenceUrl, {
                symbol,
                timestamp: candle.timestamp,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume
            });

            const data = response.data;
            const action = data.action === 1 ? 'SHORT' : 'PASS';

            return {
                symbol,
                action: action,
                confidence: data.confidence,
                longProb: 0,
                shortProb: data.confidence,
                neutralProb: 1 - data.confidence,
                features: {
                    cvd_slope: data.features?.cvd_slope,
                    cvd_z: data.features?.cvd_z,
                    weakness: data.features?.weakness
                }
            };

        } catch (error) {
            console.error('ML Service Error:', error);
            return {
                symbol,
                action: 'PASS',
                confidence: 0,
                longProb: 0,
                shortProb: 0,
                neutralProb: 1
            };
        }
    }

    async checkHealth(): Promise<boolean> {
        return true;
    }
}
