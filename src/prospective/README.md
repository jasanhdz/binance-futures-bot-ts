# Prospective Shadow Source

These CommonJS source modules were recovered from the previously deployed
`dist/prospective` runtime because their original TypeScript sources are not
present in Git. They are compiled by `npm run build` through `allowJs` and
must preserve the Shadow-only, public-REST behavior.

The unmodified baseline `shadow-service.js` is archived outside the repository
with its SHA-256 before the limiter integration. The only runtime behavior
change is the shared Binance request budget in `PublicKlineClient`.
