import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MicroBurstNetLossLedger } from '../../infra/state/MicroBurstNetLossLedger';

/** No key means no V3 admission. Initialization/reset remain externally signed operations. */
export function composeMicroNetLossLedger(
  apiKey: string,
  isTestnet: boolean,
  publicKeyFile = process.env.MICRO_NET_LOSS_OPERATOR_PUBLIC_KEY_FILE,
): MicroBurstNetLossLedger | undefined {
  if (!publicKeyFile) return undefined;
  if (!apiKey.trim()) throw new Error('MICRO_NET_LOSS_ACCOUNT_CREDENTIAL_REQUIRED');
  const account = `binance-key-${createHash('sha256').update(apiKey).digest('hex')}`;
  const environment = isTestnet ? 'testnet' : 'production';
  const data = path.join(process.cwd(), 'data');
  const runtime = path.join(data, 'runtime');
  const directory = path.join(runtime, 'micro-net-loss');
  const operatorPublicKey = fs.readFileSync(publicKeyFile, 'utf8');
  for (const parent of [process.cwd(), data, runtime, directory]) {
    try {
      fs.lstatSync(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.mkdirSync(parent, { mode: 0o700 });
    }
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
      throw new Error('MICRO_NET_LOSS_STORAGE_NOT_OWNED');
    if (parent === directory && (stat.mode & 0o077) !== 0)
      throw new Error('MICRO_NET_LOSS_STORAGE_NOT_PRIVATE');
    const fd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  const databasePath = path.join(directory, `micro-net-loss-${account}-${environment}.sqlite`);
  for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
      throw new Error('MICRO_NET_LOSS_STORAGE_NOT_OWNED');
  }
  return new MicroBurstNetLossLedger({ databasePath, account, environment, operatorPublicKey });
}
