
import { FsLogger } from './src/infra/logging/FsLogger';
import { BinanceExchange } from './src/infra/adapters/BinanceAdapter';
import dotenv from 'dotenv';

dotenv.config();

async function rescue() {
    console.log('🚑 Rescue Mission: Placing Missing Brackets');
    const logger = new FsLogger();
    const exchange = new BinanceExchange(logger);

    const SYMBOL = 'ETHUSDT';

    // Corrected Config Values
    // SL: 3.5% move against us (70% ROE loss @ 20x)
    const SL_PCT = 0.035;
    // TP: 12.5% move in our favor (250% ROE gain @ 20x)
    const TP_PCT = 0.125;

    console.log(`🔍 Fetching active position for ${SYMBOL}...`);

    // Check SHORT
    let position = await exchange.readActivePosition(SYMBOL, 'SHORT');
    let side = 'SHORT';

    if (!position) {
        position = await exchange.readActivePosition(SYMBOL, 'LONG');
        side = 'LONG';
    }

    if (!position) {
        console.error('❌ No active position found!');
        process.exit(1);
    }

    const ENTRY_PRICE = position.entryPrice;
    const QTY = position.qtyAbs;

    console.log(`✅ Found ${side} Position:`);
    console.log(`   Entry: ${ENTRY_PRICE}`);
    console.log(`   Size: ${QTY}`);

    let stopPrice: number;
    let tpPrice: number;

    if (side === 'SHORT') {
        stopPrice = ENTRY_PRICE * (1 + SL_PCT);
        tpPrice = ENTRY_PRICE * (1 - TP_PCT);
    } else {
        stopPrice = ENTRY_PRICE * (1 - SL_PCT);
        tpPrice = ENTRY_PRICE * (1 + TP_PCT);
    }

    // Rounding to 2 decimals (ETH tickSize)
    stopPrice = Number(stopPrice.toFixed(2));
    tpPrice = Number(tpPrice.toFixed(2));

    console.log(`Calculated Brackets for ${side} @ ${ENTRY_PRICE}:`);
    console.log(`🛑 SL: ${stopPrice.toFixed(2)} (3.5% dist, ~70% ROE)`);
    console.log(`💰 TP: ${tpPrice.toFixed(2)} (12.5% dist, ~250% ROE)`);

    try {
        console.log('0. Canceling existing orders...');
        // cancelAllOrders misses Algo Orders. Using cancelCloseOrdersForSide is safer.
        await exchange.cancelCloseOrdersForSide(SYMBOL, side as any);
        console.log('✅ Orders Canceled');

        console.log('1. Placing Stop Loss...');
        await exchange.placeStopClose(SYMBOL, side as any, stopPrice, QTY);
        console.log('✅ SL Placed');

        console.log('2. Placing Take Profit...');
        await exchange.placeTpClose(SYMBOL, side as any, tpPrice, QTY);
        console.log('✅ TP Placed');

        console.log('🎉 Rescue Complete');
        process.exit(0);
    } catch (error) {
        console.error('❌ Rescue Failed:', error);
        process.exit(1);
    }
}

rescue();
