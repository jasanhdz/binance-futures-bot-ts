import * as dotenv from 'dotenv';
import ccxt from 'ccxt';

dotenv.config();

async function main() {
    const exchange = new ccxt.binanceusdm({
        apiKey: process.env.BINANCE_API_KEY,
        secret: process.env.BINANCE_API_SECRET,
        enableRateLimit: true,
    });

    try {
        const balance = await exchange.fetchBalance();
        const usdt = balance?.USDT || {};
        console.log(`USDT Total: ${usdt.total}`);
        console.log(`USDT Free: ${usdt.free}`);
        console.log(`USDT Used: ${usdt.used}`);

        const positions = (balance.info as any).positions || [];
        for (const pos of positions) {
            if (pos.symbol === 'ETHUSDT' && parseFloat(pos.positionAmt) !== 0) {
                console.log(`Active Position: ${pos.positionAmt} ETH at ${pos.entryPrice}`);
            }
        }
    } catch (e) {
        console.error("Error", e);
    }
}
main();
