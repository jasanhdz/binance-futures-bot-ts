// Invoke with env -i and NODE_OPTIONS=--require=<absolute path to this file>.
// This preload runs before Vitest, worker startup and application module imports.
const path = require('node:path');
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const net = require('node:net');
const root = path.resolve(__dirname, '../..');
const dotenv = require('dotenv');
dotenv.config = () => ({ parsed: {} });
dotenv.configDotenv = () => ({ parsed: {} });
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.AEGIS_ENABLED = 'false';
process.env.AEGIS_LIVE_ENABLED = '0';
delete process.env.BINANCE_API_KEY;
delete process.env.BINANCE_API_SECRET;
const check = (file) => {
  if (typeof file === 'number') return;
  const resolved = path.resolve(
    file instanceof URL ? require('node:url').fileURLToPath(file) : String(file),
  );
  if (resolved === root || resolved.startsWith(root + path.sep))
    throw new Error(`OFFLINE_TEST_WORKSPACE_WRITE_FORBIDDEN:${resolved}`);
};
for (const name of [
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'mkdir',
  'mkdirSync',
  'rm',
  'rmSync',
  'unlink',
  'unlinkSync',
  'truncate',
  'truncateSync',
]) {
  const original = fs[name];
  fs[name] = function (file, ...args) {
    check(file);
    return original.call(this, file, ...args);
  };
}
for (const name of ['rename', 'renameSync', 'copyFile', 'copyFileSync']) {
  const original = fs[name];
  fs[name] = function (from, to, ...args) {
    check(from);
    check(to);
    return original.call(this, from, to, ...args);
  };
}
for (const name of ['open', 'openSync']) {
  const original = fs[name];
  fs[name] = function (file, flags, ...args) {
    if (
      typeof flags === 'number'
        ? (flags &
            (fs.constants.O_WRONLY |
              fs.constants.O_RDWR |
              fs.constants.O_CREAT |
              fs.constants.O_TRUNC |
              fs.constants.O_APPEND)) !==
          0
        : /[wa+]/.test(flags)
    )
      check(file);
    return original.call(this, file, flags, ...args);
  };
}
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'truncate']) {
  const original = fs.promises[name];
  fs.promises[name] = async function (file, ...args) {
    check(file);
    return original.call(this, file, ...args);
  };
}
net.Socket.prototype.connect = function () {
  throw new Error('OFFLINE_TEST_NETWORK_FORBIDDEN');
};
syncBuiltinESMExports();
