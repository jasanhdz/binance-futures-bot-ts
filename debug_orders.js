
const { BinanceExchange } = require('./src/infra/binance/BinanceExchange');
const { CONFIG } = require('./src/infra/config');
const { ConsoleLogger } = require('./src/infra/logger/ConsoleLogger');

async function main() {
    const logger = new ConsoleLogger();
    const exchange = new BinanceExchange(logger);

    console.log('Fetching open orders for SOLUSDT...');
    const orders = await exchange.getOpenOrders('SOLUSDT');
    console.log(JSON.stringify(orders, null, 2));

    console.log('Fetching Algo Orders...');
    const algoOrders = await exchange.listCloseOrdersForSide('SOLUSDT', 'SHORT'); // Side doesn't matter for raw fetch usually
    console.log(JSON.stringify(algoOrders, null, 2));
}

main();
