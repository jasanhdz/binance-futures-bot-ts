const ccxt = require('ccxt');
require('dotenv').config({path: '/home/jasan/Develop/trading_system/binance-futures-bot-ts/.env'});

async function run() {
    const exchange = new ccxt.binanceusdm({
        apiKey: process.env.BINANCE_API_KEY,
        secret: process.env.BINANCE_API_SECRET,
    });
    
    try {
        const trades = await exchange.fetchMyTrades('ETH/USDT:USDT', undefined, 20);
        console.log(`--- LAST 20 TRADES ---`);
        for (const t of trades.reverse()) {
            const date = new Date(t.timestamp).toLocaleString();
            console.log(`[${date}] ${t.side.toUpperCase()} ${t.amount} ETH @ $${t.price} | Fee: ${t.fee ? t.fee.cost : '0'} ${t.fee ? t.fee.currency : ''} | PnL: ${t.info.realizedPnl}`);
        }
    } catch (e) { console.error(e); }
}
run();
