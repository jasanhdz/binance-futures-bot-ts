from pathlib import Path
import os, re, shutil

SRC = Path('src')

# Files that are true implementations but live in the wrong architectural layer.
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

# Aegis domain services are strategy-owned domain behavior, not shared domain services.
for p in Path('src/domain/services').glob('Aegis*.ts'):
    if p.name == 'AegisStrategy.ts':
        continue
    MOVES[p] = Path('src/strategies/aegis/domain/services') / p.name
for p in Path('src/domain/services/aegis-entry').rglob('*.ts'):
    MOVES[p] = Path('src/strategies/aegis/domain/entry') / p.relative_to('src/domain/services/aegis-entry')

# Exact duplicate implementation: legacy path -> canonical path.
ALIASES = {
    Path('src/domain/services/AegisStrategy.ts'): Path('src/strategies/aegis/domain/AegisStrategy.ts'),
}

EXPORT_STAR = re.compile(r"export\s+\*\s+from\s+['\"]([^'\"]+)['\"]\s*;?")
IMPORT_SPEC = re.compile(r"(?P<prefix>(?:from\s+|export\s+\*\s+from\s+|import\s*\(\s*|require\s*\(\s*))(?P<q>['\"])(?P<spec>[^'\"]+)(?P=q)")


def resolve_relative(owner: Path, spec: str):
    if not spec.startswith('.'):
        return None
    base = (owner.parent / spec)
    candidates = [base, Path(str(base)+'.ts'), base/'index.ts']
    for c in candidates:
        c = Path(os.path.normpath(str(c)))
        if c.exists():
            return c
    return Path(os.path.normpath(str(base)))


def rel_spec(owner: Path, target: Path):
    s = os.path.relpath(target.with_suffix(''), owner.parent).replace(os.sep, '/')
    return s if s.startswith('.') else './'+s

# Discover pure one-line migration facades. Avoid real ports/interfaces by requiring export-star-only semantics.
for p in SRC.rglob('*.ts'):
    if p in MOVES or p.name.endswith('.test.ts'):
        continue
    txt = p.read_text(errors='ignore')
    matches = EXPORT_STAR.findall(txt)
    code = re.sub(r'/\*.*?\*/', '', txt, flags=re.S)
    code = re.sub(r'//.*', '', code).strip()
    if len(matches) == 1 and EXPORT_STAR.fullmatch(code):
        target = resolve_relative(p, matches[0])
        if target and target != p:
            ALIASES[p] = target

# Resolve facade chains transitively.
def canonical(path: Path):
    seen = set()
    cur = path
    while cur in ALIASES and cur not in seen:
        seen.add(cur)
        cur = ALIASES[cur]
    return MOVES.get(cur, cur)

# Map any old implementation location to moved canonical location.
PATH_MAP = {k: v for k, v in MOVES.items()}
for k, v in ALIASES.items():
    PATH_MAP[k] = canonical(v)

# Rewrite imports in all TS files based on actual resolved old targets.
for p in list(SRC.rglob('*.ts')):
    if p in ALIASES:
        continue
    txt = p.read_text(errors='ignore')
    def repl(m):
        spec = m.group('spec')
        resolved = resolve_relative(p, spec)
        if resolved is None:
            return m.group(0)
        target = PATH_MAP.get(resolved)
        if not target:
            return m.group(0)
        return f"{m.group('prefix')}{m.group('q')}{rel_spec(p, target)}{m.group('q')}"
    new = IMPORT_SPEC.sub(repl, txt)
    if new != txt:
        p.write_text(new)

# Move implementations while rebasing their own relative imports.
for old, new in MOVES.items():
    if not old.exists():
        continue
    txt = old.read_text(errors='ignore')
    def rebase(m):
        spec = m.group('spec')
        resolved = resolve_relative(old, spec)
        if resolved is None:
            return m.group(0)
        resolved = PATH_MAP.get(resolved, resolved)
        return f"{m.group('prefix')}{m.group('q')}{rel_spec(new, resolved)}{m.group('q')}"
    txt = IMPORT_SPEC.sub(rebase, txt)
    new.parent.mkdir(parents=True, exist_ok=True)
    if new.exists() and new.read_text(errors='ignore') != txt:
        raise RuntimeError(f'collision with different content: {new}')
    new.write_text(txt)
    old.unlink()

# Remove pure facades/duplicate legacy copies after consumers are canonicalized.
for p in ALIASES:
    if p.exists():
        p.unlink()

# Clean empty legacy directories.
for d in sorted([p for p in SRC.rglob('*') if p.is_dir()], key=lambda x: len(x.parts), reverse=True):
    try:
        d.rmdir()
    except OSError:
        pass

# Update architecture-contract path literals where old namespaces were explicitly named.
replacements = {
    'src/domain/strategies/aegis': 'src/strategies/aegis/domain',
    'src/domain/strategies/micro-burst': 'src/strategies/micro-burst/domain',
    'src/domain/strategies/momentum-ride': 'src/strategies/momentum/domain',
    'src/strategies/strategy': 'src/core/strategy',
    'src/strategies/types.ts': 'src/core/types.ts',
    'src/domain/strategy': 'src/core/strategy',
    'src/domain/types.ts': 'src/core/types.ts',
    'src/app/micro-burst/MicroBurstOutcomeTracker.ts': 'src/strategies/micro-burst/research/MicroBurstOutcomeTracker.ts',
    'src/app/micro-burst/MicroBurstStorage.ts': 'src/strategies/micro-burst/research/MicroBurstStorage.ts',
    'src/app/strategy/MicroBurstPositionManager.ts': 'src/strategies/micro-burst/application/MicroBurstPositionManager.ts',
}
for p in list(SRC.rglob('*.ts')):
    txt = p.read_text(errors='ignore')
    new = txt
    for a,b in replacements.items():
        new = new.replace(a,b)
    if new != txt:
        p.write_text(new)

print(f'facades_removed={len(ALIASES)}')
print(f'implementations_moved={len(MOVES)}')
for old,new in sorted(PATH_MAP.items(), key=lambda kv: str(kv[0])):
    print(f'{old} -> {new}')
