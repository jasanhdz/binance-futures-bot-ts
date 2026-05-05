const Binance = require('binance-api-node').default;
const client = Binance();

async function run() {
    const candles = await client.futuresCandles({ symbol: 'ETHUSDT', interval: '5m', limit: 1 });
    console.log("REST CANDLE:", candles[0]);
    
    console.log("WAITING 3 seconds for WS CANDLE...");
    const clean = client.ws.futuresCandles('ETHUSDT', '5m', (candle) => {
        console.log("WS CANDLE:", candle);
        clean();
        process.exit(0);
    });
}
run();
