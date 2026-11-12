import {
  existsSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function hashTree(directory: string): { path: string; sha256: string }[] {
  const files: { path: string; sha256: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name),
        stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target)) throw new Error(`FROZEN_TREE_ABSOLUTE_SYMLINK:${path}`);
        const resolvedTarget = resolve(dir, target);
        const realRoot = realpathSync(directory);
        const realTarget = realpathSync(resolvedTarget);
        if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`))
          throw new Error(`FROZEN_TREE_EXTERNAL_SYMLINK:${path}`);
        files.push({
          path: relative(directory, path),
          sha256: createHash('sha256').update(`SYMLINK:${target}`).digest('hex'),
        });
      } else
        files.push({
          path: relative(directory, path),
          sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        });
    }
  };
  walk(directory);
  return files;
}

export interface VerifiedFrozenCollectorArtifact {
  readonly root: string;
  readonly artifactHash: string;
  readonly codeSha256: string;
  readonly configSha256: string;
  readonly gitCommit: string;
  readonly sourceDirty: boolean;
}

const verifiedArtifacts = new WeakSet<object>();

/** Re-hash the frozen bytes; a manifest alone is not accepted as verification. */
export function verifyFrozenCollectorArtifact(root: string): VerifiedFrozenCollectorArtifact {
  const directory = resolve(root);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (
    manifest.schema !== 'MICRO_COLLECTOR_FROZEN_V2' ||
    manifest.authority !== 'OBSERVATION_ONLY' ||
    manifest.credentialPolicy !== 'EMPTY_KEYS_DOTENV_DEV_NULL' ||
    manifest.nodeVersion !== process.version ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    !/^[a-f0-9]{40}$/.test(manifest.gitCommit) ||
    !manifest.files
  )
    throw new Error('FROZEN_COLLECTOR_MANIFEST_INCOMPATIBLE');
  const files = {
    source: hashTree(join(directory, 'src')),
    code: hashTree(join(directory, 'code')),
    dependencies: hashTree(join(directory, 'node_modules')),
    packageJson: createHash('sha256')
      .update(readFileSync(join(directory, 'package.json')))
      .digest('hex'),
    tsconfig: createHash('sha256')
      .update(readFileSync(join(directory, 'tsconfig.json')))
      .digest('hex'),
    config: createHash('sha256')
      .update(readFileSync(join(directory, 'regime_config.live.yaml')))
      .digest('hex'),
    lock: createHash('sha256')
      .update(readFileSync(join(directory, 'package-lock.json')))
      .digest('hex'),
  };
  if (
    JSON.stringify(files) !== JSON.stringify(manifest.files) ||
    createHash('sha256').update(JSON.stringify(files)).digest('hex') !== manifest.artifactHash ||
    createHash('sha256').update(JSON.stringify(files.code)).digest('hex') !== manifest.codeSha256
  )
    throw new Error('FROZEN_COLLECTOR_ARTIFACT_HASH_MISMATCH');
  const verified: VerifiedFrozenCollectorArtifact = Object.freeze({
    root: directory,
    artifactHash: manifest.artifactHash,
    codeSha256: manifest.codeSha256,
    configSha256: files.config,
    gitCommit: manifest.gitCommit,
    sourceDirty: manifest.sourceDirty === true,
  });
  verifiedArtifacts.add(verified);
  return verified;
}

export function isVerifiedFrozenCollectorArtifact(
  value: unknown,
): value is VerifiedFrozenCollectorArtifact {
  return Boolean(value && typeof value === 'object' && verifiedArtifacts.has(value));
}

/** One-shot snapshot. Compiles frozen sources against copied dependencies, never overwrites LIVE dist. */
export function freezeCollector(workspace: string, destination: string): Record<string, unknown> {
  const root = resolve(workspace),
    out = resolve(destination);
  mkdirSync(out, { recursive: false, mode: 0o700 });
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const sourceBefore = hashTree(join(root, 'src'));
  for (const name of ['src', 'node_modules', ...(existsSync(join(root, 'types')) ? ['types'] : [])])
    cpSync(join(root, name), join(out, name), { recursive: true, verbatimSymlinks: true });
  for (const name of [
    'tsconfig.json',
    'package.json',
    'package-lock.json',
    'regime_config.live.yaml',
  ])
    cpSync(join(root, name), join(out, name));
  if (
    JSON.stringify(sourceBefore) !== JSON.stringify(hashTree(join(out, 'src'))) ||
    JSON.stringify(sourceBefore) !== JSON.stringify(hashTree(join(root, 'src')))
  )
    throw new Error('SOURCE_CHANGED_DURING_FREEZE');
  execFileSync(
    process.execPath,
    [
      join(out, 'node_modules/typescript/bin/tsc'),
      '-p',
      join(out, 'tsconfig.json'),
      '--outDir',
      join(out, 'code'),
    ],
    { cwd: out, stdio: 'inherit' },
  );
  const files = {
    source: sourceBefore,
    code: hashTree(join(out, 'code')),
    dependencies: hashTree(join(out, 'node_modules')),
    packageJson: createHash('sha256')
      .update(readFileSync(join(out, 'package.json')))
      .digest('hex'),
    tsconfig: createHash('sha256')
      .update(readFileSync(join(out, 'tsconfig.json')))
      .digest('hex'),
    config: createHash('sha256')
      .update(readFileSync(join(out, 'regime_config.live.yaml')))
      .digest('hex'),
    lock: createHash('sha256')
      .update(readFileSync(join(out, 'package-lock.json')))
      .digest('hex'),
  };
  const artifactHash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const codeSha256 = createHash('sha256').update(JSON.stringify(files.code)).digest('hex');
  const manifest = {
    schema: 'MICRO_COLLECTOR_FROZEN_V2',
    createdAtMs: Date.now(),
    gitCommit,
    artifactHash,
    codeSha256,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    packageJsonSha256: files.packageJson,
    tsconfigSha256: files.tsconfig,
    sourceDirty:
      execFileSync('git', ['status', '--porcelain', '--', 'src'], {
        cwd: root,
        encoding: 'utf8',
      }).trim() !== '',
    authority: 'OBSERVATION_ONLY',
    credentialPolicy: 'EMPTY_KEYS_DOTENV_DEV_NULL',
    files,
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  return {
    root: out,
    artifactHash,
    gitCommit,
    sourceDirty: manifest.sourceDirty,
    collectorEntryPoint: join(out, 'code/tooling/micro-burst/MicroBurstContinuousCollector.js'),
    supervisorCommand:
      'DOTENV_CONFIG_PATH=/dev/null npm run micro-burst:collector-supervise -- <bounded-run-plan.json>',
    maximumDurationSeconds: 1200,
  };
}

if (require.main === module) {
  if (!process.argv[2])
    throw new Error('USAGE: MicroBurstCollectorFreeze <new-directory-in-existing-parent>');
  console.log(JSON.stringify(freezeCollector(process.cwd(), process.argv[2]), null, 2));
}
