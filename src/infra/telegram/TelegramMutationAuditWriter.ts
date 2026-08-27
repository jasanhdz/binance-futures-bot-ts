import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import {
  TelegramMutationAuditRecord,
  TelegramMutationAuditWriter as TelegramMutationAuditWriterPort,
} from '../../app/telegram/TelegramCommandTypes';

export class TelegramMutationAuditWriter implements TelegramMutationAuditWriterPort {
  constructor(
    private readonly filePath = process.env.TELEGRAM_MUTATION_AUDIT_PATH ||
      'logs/telegram_mutations.jsonl',
  ) {}

  async append(record: TelegramMutationAuditRecord): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}
