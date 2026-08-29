from pathlib import Path
import hashlib
import os
import re

SRC = Path('src')

MOVES = {
    Path('src/app/micro-burst/MicroBurstOutcomeTracker.ts'): Path('src/strategies/micro-burst/research/MicroBurstOutcomeTracker.ts'),
    Path('src/app/micro-burst/MicroBurstStorage.ts'): Path('src/strategies/micro-burst/research/MicroBurstStorage.ts'),
    Path('src/app/micro-burst/MicroBurstPaperTradeJournal.test.ts'): Path('src/strategies/micro-burst/research/MicroBurstPaperTradeJournal.test.ts'),
    Path('src/app/micro-burst/MicroBurstStorage.test.ts'): Path('src/strategies/micro-burst/research/MicroBurstStorage.test.ts'),
    Path('src/app/micro-burst/MicroBurstTradeHistoryStore.test.ts'): Path('src/strategies/micro-burst/research/MicroBurstTradeHistoryStore.test.ts'),
    Path('src/strategies/micro-burst/domain/MicroBurstRuntime.ts'): Path('src/strategies/micro-burst/application/MicroBurstRuntime.ts'),
    Path('src/strategies/micro-burst/domain/MicroBurstRuntime.test.ts'): Path('src/strategies/micro-burst/application/MicroBurstRuntime.test.ts'),
    Path('src/strategies/micro-burst/domain/MicroBurstOutcomeTracker.test.ts'): Path('src/strategies/micro-burst/research/MicroBurstOutcomeTracker.test.ts'),
    Path('src/strategies/micro-burst/domain/MicroBurstOutcomeEngine.test.ts'): Path('src/strategies/micro-burst/research/MicroBurstOutcomeEngine.test.ts'),
}

for p in Path('src/domain/services').glob('Aegis*.ts'):
    if p.name == 'AegisStrategy.ts':
        continue
    MOVES[p] = Path('src/strategies/aegis/domain/services') / p.name
for p in Path('src/domain/services/aegis-entry').rglob('*.ts'):
    MOVES[p] = Path('src/strategies/aegis/domain/entry') / p.relative_to('src/domain/services/aegis-entry')

ALIASES = {
    Path('src/domain/services/AegisStrategy.ts'): Path('src/strategies/aegis/domain/AegisStrategy.ts'),
    Path('src/domain/services/CurrentBrainCanonicalDecision.ts'): Path('src/strategies/aegis/domain/CurrentBrainCanonicalDecision.ts'),
}

EXPORT_STAR = re.compile(r"export\s+\*\s+from\s+['\"]([^'\"]+)['\"]\s*;?")
IMPORT_SPEC = re.compile(r"(?P<prefix>(?:from\s+|export\s+\*\s+from\s+|import\s*\(\s*|require\s*\(\s*))(?P<q>['\"])(?P<spec>[^'\"]+)(?P=q)")


def resolve_relative(owner: Path, spec: str):
    if not spec.startswith('.'):
        return None
    base = owner.parent / spec
    for candidate in [base, Path(str(base) + '.ts'), base / 'index.ts']:
        candidate = Path(os.path.normpath(str(candidate)))
        if candidate.exists():
            return candidate
    return Path(os.path.normpath(str(base)))


def rel_spec(owner: Path, target: Path):
    value = os.path.relpath(target.with_suffix(''), owner.parent).replace(os.sep, '/')
    return value if value.startswith('.') else './' + value


for p in SRC.rglob('*.ts'):
    if p in MOVES or p.name.endswith('.test.ts'):
        continue
    text = p.read_text(errors='ignore')
    matches = EXPORT_STAR.findall(text)
    code = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    code = re.sub(r'//.*', '', code).strip()
    if len(matches) == 1 and EXPORT_STAR.fullmatch(code):
        target = resolve_relative(p, matches[0])
        if target and target != p:
            ALIASES[p] = target


def canonical(path: Path):
    seen = set()
    cur = path
    while cur in ALIASES and cur not in seen:
        seen.add(cur)
        cur = ALIASES[cur]
    return MOVES.get(cur, cur)


PATH_MAP = {**MOVES}
for old, target in ALIASES.items():
    PATH_MAP[old] = canonical(target)

# Canonicalize imports in existing production/tests before moving files.
for p in list(SRC.rglob('*.ts')):
    if p in ALIASES:
        continue
    text = p.read_text(errors='ignore')

    def rewrite_import(match):
        resolved = resolve_relative(p, match.group('spec'))
        target = PATH_MAP.get(resolved) if resolved else None
        if not target:
            return match.group(0)
        return f"{match.group('prefix')}{match.group('q')}{rel_spec(p, target)}{match.group('q')}"

    new = IMPORT_SPEC.sub(rewrite_import, text)
    if new != text:
        p.write_text(new)

# Move true implementations/tests and rebase relative imports.
for old, new in MOVES.items():
    if not old.exists():
        continue
    text = old.read_text(errors='ignore')

    def rebase_import(match):
        resolved = resolve_relative(old, match.group('spec'))
        if resolved is None:
            return match.group(0)
        resolved = PATH_MAP.get(resolved, resolved)
        return f"{match.group('prefix')}{match.group('q')}{rel_spec(new, resolved)}{match.group('q')}"

    text = IMPORT_SPEC.sub(rebase_import, text)
    new.parent.mkdir(parents=True, exist_ok=True)
    if new.exists() and new.read_text(errors='ignore') != text:
        raise RuntimeError(f'collision with different content: {new}')
    new.write_text(text)
    old.unlink()

for p in ALIASES:
    if p.exists():
        p.unlink()

# Update path literals in architecture/restoration contracts to canonical ownership.
path_replacements = [
    ('src/domain/services/aegis-entry/', 'src/strategies/aegis/domain/entry/'),
    ('src/domain/services/CurrentBrainCanonicalDecision.ts', 'src/strategies/aegis/domain/CurrentBrainCanonicalDecision.ts'),
    ('src/domain/services/AegisStrategy.ts', 'src/strategies/aegis/domain/AegisStrategy.ts'),
    ('src/domain/services/Aegis', 'src/strategies/aegis/domain/services/Aegis'),
    ('src/domain/strategies/aegis/', 'src/strategies/aegis/domain/'),
    ('src/domain/strategies/micro-burst/', 'src/strategies/micro-burst/domain/'),
    ('src/domain/strategies/momentum-ride/', 'src/strategies/momentum/domain/'),
    ('src/strategies/strategy/', 'src/core/strategy/'),
    ('src/strategies/types.ts', 'src/core/types.ts'),
    ('src/domain/strategy/', 'src/core/strategy/'),
    ('src/domain/risk/', 'src/core/risk/'),
    ('src/domain/types.ts', 'src/core/types.ts'),
    ('src/app/micro-burst/MicroBurstOutcomeTracker.ts', 'src/strategies/micro-burst/research/MicroBurstOutcomeTracker.ts'),
    ('src/app/micro-burst/MicroBurstStorage.ts', 'src/strategies/micro-burst/research/MicroBurstStorage.ts'),
    ('src/app/strategy/MicroBurstPositionManager.ts', 'src/strategies/micro-burst/application/MicroBurstPositionManager.ts'),
    ('src/strategies/micro-burst/domain/MicroBurstRuntime.ts', 'src/strategies/micro-burst/application/MicroBurstRuntime.ts'),
]
for p in list(SRC.rglob('*.ts')):
    text = p.read_text(errors='ignore')
    new = text
    for old, target in path_replacements:
        new = new.replace(old, target)
    if new != text:
        p.write_text(new)

# Phase 0: the final architecture has no compatibility allowlist; shared/core may not import strategies.
phase0 = Path('src/restoration/phase0-architecture-contracts.test.ts')
if phase0.exists():
    text = phase0.read_text()
    start = text.find('const concreteStrategyPrefixes = [')
    end = text.find('const mutationMethods = new Set(', start)
    if start >= 0 and end >= 0:
        replacement = """const concreteStrategyPrefixes = [\n  'src/strategies/aegis/',\n  'src/strategies/momentum/',\n  'src/strategies/micro-burst/',\n];\n\nconst sharedRoots = [\n  'src/core/',\n  'src/app/execution/',\n  'src/app/position/',\n  'src/app/ports/',\n];\n\nconst sharedImportAllowlist: Record<string, string[]> = {};\n\n"""
        text = text[:start] + replacement + text[end:]
        phase0.write_text(text)

# Phase R: compatibility shims are no longer a desired final state.
market_test = Path('src/core/market-data/MarketDataConvergence.test.ts')
if market_test.exists():
    text = market_test.read_text()
    text = text.replace("import { readFileSync, readdirSync } from 'node:fs';", "import { existsSync, readFileSync, readdirSync } from 'node:fs';")
    old_block = """  it('turns app-level generic Micro Burst files into re-export-only compatibility shims', () => {\n    expect(source('app/micro-burst/MicroBurstClocks.ts').trim()).toBe(\n      \"/** @deprecated Generic clock mechanics live in core/market-data. */\\nexport * from '../../core/market-data/MarketDataClocks';\",\n    );\n    expect(source('app/micro-burst/MicroBurstMarketData.ts').trim()).toBe(\n      \"/** @deprecated Generic normalized market events live in core/market-data. */\\nexport * from '../../core/market-data/NormalizedMarketEvents';\",\n    );\n    expect(source('app/micro-burst/MicroBurstStreamGapDetector.ts').trim()).toBe(\n      \"/** @deprecated Generic depth continuity mechanics live in core/market-data. */\\nexport * from '../../core/market-data/DepthStreamGapDetector';\",\n    );\n  });\n"""
    new_block = """  it('removes obsolete app-level Micro Burst market-data compatibility shims', () => {\n    for (const legacyPath of [\n      'app/micro-burst/MicroBurstClocks.ts',\n      'app/micro-burst/MicroBurstMarketData.ts',\n      'app/micro-burst/MicroBurstStreamGapDetector.ts',\n    ]) {\n      expect(existsSync(resolve(srcRoot, legacyPath)), legacyPath).toBe(false);\n    }\n  });\n"""
    if old_block in text:
        text = text.replace(old_block, new_block)
    market_test.write_text(text)

# Rewrite obsolete Phase 2 wording: these are canonical strategy adapters now, not legacy facades.
phase2 = Path('src/restoration/phase2-architecture-contracts.test.ts')
if phase2.exists():
    text = phase2.read_text().replace(
        "keeps legacy compatibility adapters dependent on generic cores",
        "keeps canonical strategy adapters dependent on generic cores",
    )
    phase2.write_text(text)

# Update exact hashes only for explicitly owner-authorized files changed by import/path convergence.
semantics = Path('src/restoration/original-operational-semantics.test.ts')
if semantics.exists():
    text = semantics.read_text()
    authorized = {
        'src/app/ports/Exchange.ts',
        'src/app/services/TradingService.ts',
        'src/domain/index.ts',
        *[str(p) for p in MOVES.values() if not p.name.endswith('.test.ts')],
        'src/strategies/aegis/domain/AegisStrategy.ts',
        'src/strategies/aegis/domain/CurrentBrainCanonicalDecision.ts',
    }
    entry = re.compile(r"('(?P<path>src/[^']+)'\s*:\s*\n?\s*)'(?P<hash>[0-9a-f]{64})'")

    def refresh_digest(match):
        path = match.group('path')
        file = Path(path)
        if path not in authorized or not file.exists():
            return match.group(0)
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        return match.group(1) + f"'{digest}'"

    text = entry.sub(refresh_digest, text)
    semantics.write_text(text)

# Remove empty legacy directories.
for d in sorted([p for p in SRC.rglob('*') if p.is_dir()], key=lambda x: len(x.parts), reverse=True):
    try:
        d.rmdir()
    except OSError:
        pass

print(f'facades_removed={len(ALIASES)}')
print(f'implementations_moved={len(MOVES)}')
for old, new in sorted(PATH_MAP.items(), key=lambda pair: str(pair[0])):
    print(f'{old} -> {new}')
