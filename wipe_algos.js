const { BinanceExchange } = require('./build/infra/adapters/BinanceAdapter');
const { MockLogger } = require('./build/backtest/adapters/MockLogger');
const { WsManager } = require('./build/infra/adapters/WsManager');

async function run() {
  const ws = new WsManager(new MockLogger());
  const exchange = new BinanceExchange(new MockLogger(), ws);
  try {
    await exchange.cancelCloseOrdersForSide("ETHUSDT", "SHORT");
    console.log("WIPED ALL OFFENDING BRACKETS");
  } catch(e) {
    console.log("FAILED:", e.message || e);
  }
}
run();
