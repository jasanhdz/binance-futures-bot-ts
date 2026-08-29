/** Process entry point. Strategy composition lives behind the application bootstrap boundary. */
import { createTradingApplication } from './app/bootstrap/TradingApplicationBootstrap';

async function main(): Promise<void> {
  console.log('Trading System');
  console.log('==============');

  const application = createTradingApplication();
  console.log(`Runtime mode: ${application.summary.runtimeMode}`);
  console.log(`Active symbols: ${application.summary.symbols.join(', ')}`);
  console.log(`Tick interval: ${application.summary.tickIntervalMs}ms`);

  let exiting = false;
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
    if (exiting) return;
    exiting = true;
    const completed = await application.stop(signal);
    process.exit(completed ? 0 : 1);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await application.start();
  } catch (error) {
    console.error('Fatal startup error:', error);
    process.exitCode = 1;
  }
}

void main();
