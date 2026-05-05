import { ConsoleLogger } from './src/infra/logging/ConsoleLogger';
import { BinanceExchange } from './src/infra/adapters/BinanceAdapter';
import { MlServiceWrapper } from './src/app/services/MlServiceWrapper';

async function scan() {
    const logger = new ConsoleLogger();
    const exchange = new BinanceExchange(logger as any);
    const mlService = new MlServiceWrapper(logger as any, exchange);

    const price = await exchange.getMarkPrice('ETHUSDT');
    const signal = await mlService.getSignal('ETHUSDT');

    console.log(`\n===================`);
    console.log(` ETHUSDT: $${price}`);
    console.log(` PROBABILITIES: `);
    console.log(` LONG:  ${((signal.longProb || 0) * 100).toFixed(2)}%`);
    console.log(` SHORT: ${((signal.shortProb || 0) * 100).toFixed(2)}%`);
    console.log(` IDLE:  ${((signal.neutralProb || 0) * 100).toFixed(2)}%`);
    console.log(` CLOSE: ${((signal.closeProb || 0) * 100).toFixed(2)}%`);
    console.log(` CVD Z-SCORE: ${signal.metadata?.cvdZ}`);
    console.log(` CVD SLOPE: ${signal.metadata?.cvdSlope}`);
    console.log(`===================\n`);
    process.exit(0);
}

scan().catch(console.error);
