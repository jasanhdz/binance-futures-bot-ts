import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { MicroUtcClock } from '../../infra/state/MicroUtcClock';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto';
import { composeMicroNetLossLedger } from '../../app/bootstrap/MicroNetLossComposition';
import {
  microBurstLossResetPayload,
  type MicroBurstLossResetCommand,
} from '../../infra/state/MicroBurstNetLossLedger';

/** Explicit operator CLI only. The trading runtime imports neither this module nor private keys. */
export async function initializeLocalMicroLedger(options: {
  keyDirectory: string;
  apiKey: string;
  isTestnet: boolean;
  reason: string;
  readServerTime: () => Promise<number>;
}): Promise<{ publicKeyFile: string; revision: number; initialized: boolean }> {
  if (
    !options.apiKey.trim() ||
    !options.reason.trim() ||
    options.reason.length > 1000 ||
    !path.isAbsolute(options.keyDirectory)
  )
    throw new Error('MICRO_OPERATOR_EXPLICIT_INITIALIZATION_ARGUMENTS_REQUIRED');
  const clock = new MicroUtcClock(options.readServerTime);
  await clock.ready();
  const parent = path.dirname(options.keyDirectory);
  const account = `binance-key-${createHash('sha256').update(options.apiKey).digest('hex')}`;
  const environment = options.isTestnet ? 'testnet' : 'production';
  const databasePath = path.join(
    process.cwd(),
    'data',
    'runtime',
    'micro-net-loss',
    `micro-net-loss-${account}-${environment}.sqlite`,
  );
  if (
    fs.existsSync(databasePath) &&
    !fs.existsSync(path.join(options.keyDirectory, 'operator.public.pem'))
  )
    throw new Error('MICRO_OPERATOR_EXISTING_LEDGER_REQUIRES_PINNED_KEY');
  const parentStat = fs.lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.uid !== process.getuid?.()
  )
    throw new Error('MICRO_OPERATOR_PARENT_NOT_OWNED');
  if (!fs.existsSync(options.keyDirectory)) fs.mkdirSync(options.keyDirectory, { mode: 0o700 });
  const directoryStat = fs.lstatSync(options.keyDirectory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== process.getuid?.() ||
    directoryStat.mode & 0o077
  )
    throw new Error('MICRO_OPERATOR_DIRECTORY_NOT_PRIVATE');
  const privateKeyFile = path.join(options.keyDirectory, 'operator.private.pem');
  const publicKeyFile = path.join(options.keyDirectory, 'operator.public.pem');
  if (!fs.existsSync(privateKeyFile) && !fs.existsSync(publicKeyFile)) {
    const keys = generateKeyPairSync('ed25519');
    fs.writeFileSync(privateKeyFile, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      flag: 'wx',
      mode: 0o600,
    });
    fs.writeFileSync(publicKeyFile, keys.publicKey.export({ format: 'pem', type: 'spki' }), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  for (const file of [privateKeyFile, publicKeyFile]) {
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      throw new Error('MICRO_OPERATOR_KEY_NOT_PRIVATE');
    const fd = fs.openSync(file, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  const privateKey = createPrivateKey(fs.readFileSync(privateKeyFile));
  const publicKey = createPublicKey(fs.readFileSync(publicKeyFile));
  if (
    privateKey.asymmetricKeyType !== 'ed25519' ||
    !createPublicKey(privateKey)
      .export({ type: 'spki', format: 'der' })
      .equals(publicKey.export({ type: 'spki', format: 'der' }))
  )
    throw new Error('MICRO_OPERATOR_KEY_PAIR_MISMATCH');
  const ledger = composeMicroNetLossLedger(
    options.apiKey,
    options.isTestnet,
    publicKeyFile,
    options.readServerTime,
    clock,
  )!;
  try {
    const snapshot = ledger.snapshot();
    if (snapshot.initialized || snapshot.pendingSettlements || snapshot.halted)
      throw new Error('MICRO_OPERATOR_INITIALIZATION_NOT_PRISTINE');
    const now = clock.now();
    const command: MicroBurstLossResetCommand = {
      schemaVersion: 1,
      action: 'INITIALIZE',
      account,
      environment,
      strategyId: 'MICRO_BURST',
      policyVersion: 'MICRO',
      expectedRevision: snapshot.revision,
      nonce: randomUUID(),
      issuedAtMs: now,
      expiresAtMs: now + 300_000,
      reason: options.reason,
    };
    const signature = sign(null, microBurstLossResetPayload(command), privateKey).toString(
      'base64',
    );
    const record = path.join(options.keyDirectory, `initialization-${command.nonce}.json`);
    fs.writeFileSync(
      record,
      JSON.stringify({ signerProvenance: 'LOCAL_OWNER_GENERATED_ED25519', command, signature }),
      { flag: 'wx', mode: 0o600 },
    );
    for (const file of [record, options.keyDirectory, parent]) {
      const fd = fs.openSync(file, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    ledger.applyOperatorCommand(command, signature);
    return {
      publicKeyFile,
      initialized: ledger.snapshot().initialized,
      revision: ledger.snapshot().revision,
    };
  } finally {
    ledger.close();
  }
}

if (require.main === module) {
  const [action, directory, reason, ...extra] = process.argv.slice(2);
  if (action !== 'initialize-local' || !directory || !reason || extra.length) {
    console.error(
      'Usage: MicroNetLossOperator initialize-local ABSOLUTE_PRIVATE_KEY_DIRECTORY EXPLICIT_REASON',
    );
    process.exitCode = 1;
  } else {
    void (async () => {
      try {
        console.log(
          JSON.stringify(
            await initializeLocalMicroLedger({
              keyDirectory: directory,
              reason,
              apiKey: process.env.BINANCE_API_KEY ?? '',
              isTestnet: process.env.IS_TESTNET === '1',
              readServerTime: async () => {
                const base =
                  process.env.IS_TESTNET === '1'
                    ? 'https://demo-fapi.binance.com'
                    : 'https://fapi.binance.com';
                const response = await axios.get(`${base}/fapi/v1/time`, {
                  timeout: 2000,
                  maxRedirects: 0,
                });
                return response.data.serverTime;
              },
            }),
          ),
        );
      } catch {
        console.error(
          'MICRO_OPERATOR_INITIALIZATION_FAILED: no reset performed; inspect permissions, scope and existing initialization',
        );
        process.exitCode = 1;
      }
    })();
  }
}
