from pathlib import Path
import re

ROOT = Path('src')

print('=== SMALL TS FILES <= 220 bytes ===')
for p in sorted(ROOT.rglob('*.ts')):
    if p.name.endswith('.test.ts'):
        continue
    size = p.stat().st_size
    if size <= 220:
        txt = p.read_text(errors='ignore').strip().replace('\n', ' | ')
        print(f'{size:4d} {p}: {txt[:220]}')

print('\n=== STRATEGY-NAMED FILES OUTSIDE src/strategies ===')
pat = re.compile(r'(Aegis|MicroBurst|MomentumRide|Momentum)', re.I)
for p in sorted(ROOT.rglob('*.ts')):
    rel = str(p)
    if rel.startswith('src/strategies/'):
        continue
    if pat.search(p.name):
        print(f'{p.stat().st_size:6d} {p}')

print('\n=== LEGACY PATH IMPORTS ===')
legacy_tokens = [
    'domain/strategies/', 'strategies/strategy/', 'strategies/types',
    'app/micro-burst/', 'app/strategy/MicroBurstPositionManager',
]
for p in sorted(ROOT.rglob('*.ts')):
    txt = p.read_text(errors='ignore')
    hits = [t for t in legacy_tokens if t in txt]
    if hits:
        print(f'{p}: {hits}')

print('\n=== LARGE FILES >= 20KB ===')
for p in sorted(ROOT.rglob('*.ts')):
    if p.stat().st_size >= 20_000:
        print(f'{p.stat().st_size:7d} {p}')

print('\n=== TOP-LEVEL SRC DIRECTORIES ===')
for p in sorted(ROOT.iterdir()):
    print(p)
