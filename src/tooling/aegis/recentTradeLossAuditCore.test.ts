import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';

describe('recentTradeLossAuditCore', () => {
    it('loads through ts-node and handles an empty audit window', () => {
        const output = execFileSync('node', [
            '-r',
            'ts-node/register',
            '-e',
            [
                "const { auditRecentLosingTrades } = require('./src/tooling/aegis/recentTradeLossAuditCore');",
                "auditRecentLosingTrades({ repoRoot: process.cwd(), symbols: ['ETHUSDT'], from: '2099-01-01', to: '2099-01-02', charts: false, writeReports: false })",
                ".then((report) => { console.log(JSON.stringify({ trades: report.trades.length, warnings: report.warnings.length })); })",
                ".catch((error) => { console.error(error); process.exit(1); });"
            ].join('')
        ], {
            cwd: process.cwd(),
            encoding: 'utf8'
        });

        const parsed = JSON.parse(output);
        expect(parsed.trades).toBe(0);
        expect(parsed.warnings).toBeGreaterThanOrEqual(2);
    });
});
