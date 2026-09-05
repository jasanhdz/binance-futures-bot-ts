#!/usr/bin/env bash
set -euo pipefail

# Keep the two config-sensitive test populations disjoint without changing
# production config precedence or loading credentials.
npm run build
REGIME_CONFIG=regime_config.live.yaml npx vitest run --silent \
  --exclude src/infra/config/ConfigLoader.aegis-symbols.test.ts
env -u REGIME_CONFIG npx vitest run \
  src/infra/config/ConfigLoader.aegis-symbols.test.ts --silent
git diff --check
