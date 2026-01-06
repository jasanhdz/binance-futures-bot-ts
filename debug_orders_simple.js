
require('dotenv').config();
const crypto = require('crypto');

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const HTTP_FUTURES = 'https://fapi.binance.com';

async function fetchBinance(endpoint, params = {}) {
    const qs = Object.keys(params).map(k => `${k}=${params[k]}`).join('&');
    const signature = crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
    const url = `${HTTP_FUTURES}${endpoint}?${qs}&signature=${signature}`;

    const res = await fetch(url, {
        headers: { 'X-MBX-APIKEY': API_KEY }
    });
    return res.json();
}

async function main() {
    const timestamp = Date.now();

    console.log('--- OPEN ORDERS (Standard) ---');
    const open = await fetchBinance('/fapi/v1/openOrders', { symbol: 'SOLUSDT', timestamp });
    console.log(JSON.stringify(open, null, 2));

    console.log('--- ALGO ORDERS (Conditional) ---');
    const algo = await fetchBinance('/fapi/v1/openAlgoOrders', { symbol: 'SOLUSDT', timestamp });
    console.log(JSON.stringify(algo, null, 2));
}

main();
