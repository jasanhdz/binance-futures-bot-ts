import { BinanceExchange } from './src/infra/adapters/BinanceAdapter';
import { FsLogger } from './src/infra/logging/FsLogger';

async function check() {
    try {
        const ex = new BinanceExchange(new FsLogger());
        const bal = await ex.getUSDTBalance();
        console.log("ACTUAL_BALANCE_USDT:", bal);
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}
check();
