import { BinanceExchange } from '../../infra/adapters/BinanceAdapter';
import { TelegramService } from '../../infra/adapters/TelegramAdapter';
import { NinjaConfigManager } from '../../infra/config/ConfigLoader';
import { FsLogger } from '../../infra/logging/FsLogger';
import { FsStateStore } from '../../infra/logging/FsStateStore';
import type { Notifier } from '../ports/Notifier';

class TelegramNotifier implements Notifier {
  async sendMessage(message: string): Promise<void> {
    await TelegramService.sendAlert(message);
  }

  async sendAlert(title: string, body: string): Promise<void> {
    await TelegramService.sendAlert(`⚠️ ${title}\n${body}`);
  }
}

export function createApplicationInfrastructure() {
  const logger = new FsLogger();
  return {
    logger,
    exchange: new BinanceExchange(logger),
    stateStore: new FsStateStore('aegis_state.json'),
    notifier: new TelegramNotifier(),
    configManager: new NinjaConfigManager(),
  };
}
