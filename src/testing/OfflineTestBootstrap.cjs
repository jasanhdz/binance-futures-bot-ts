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
    if (name.startsWith('rename')) check(from);
    check(to);
    return original.call(this, from, to, ...args);
  };
}
for (const [owner, name] of [
  [fs, 'open'],
  [fs, 'openSync'],
  [fs.promises, 'open'],
]) {
  const original = owner[name];
  owner[name] = function (file, flags, ...args) {
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
const createWriteStream = fs.createWriteStream;
fs.createWriteStream = function (file, ...args) {
  check(file);
  return createWriteStream.call(this, file, ...args);
};
for (const name of ['rename', 'copyFile', 'cp', 'link', 'symlink']) {
  const original = fs.promises[name];
  fs.promises[name] = async function (from, to, ...args) {
    if (!['copyFile', 'cp'].includes(name)) check(from);
    check(to);
    return original.call(this, from, to, ...args);
  };
}
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'truncate']) {
  const original = fs.promises[name];
  fs.promises[name] = async function (file, ...args) {
    check(file);
    return original.call(this, file, ...args);
  };
}
// Only ephemeral loopback listeners created by this test process are reachable.
// Production loopback services and every remote destination remain denied.
const ownedPorts = new Set();
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
  if (options.port !== 0 || !['127.0.0.1', '::1'].includes(options.host))
    throw new Error('OFFLINE_TEST_LISTENER_FORBIDDEN');
  let port;
  this.once('listening', () => {
    port = this.address().port;
    ownedPorts.add(port);
  });
  this.once('close', () => {
    ownedPorts.delete(port);
  });
  return listen.apply(this, args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const options = normalized[0];
  if (
    options &&
    typeof options === 'object' &&
    !options.path &&
    ['127.0.0.1', '::1'].includes(options.host) &&
    ownedPorts.has(Number(options.port))
  )
    return connect.apply(this, args);
  throw new Error('OFFLINE_TEST_NETWORK_FORBIDDEN');
};
// Native SQLite bypasses patched JavaScript fs entry points.
const databasePath = require.resolve('better-sqlite3');
const Database = require(databasePath);
require.cache[databasePath].exports = new Proxy(Database, {
  construct(target, args) {
    if (args[0] && args[0] !== ':memory:') check(args[0]);
    return Reflect.construct(target, args);
  },
  apply(target, receiver, args) {
    if (args[0] && args[0] !== ':memory:') check(args[0]);
    return Reflect.apply(target, receiver, args);
  },
});
syncBuiltinESMExports();
