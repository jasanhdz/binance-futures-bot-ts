import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('recentTradeLossAuditCore', () => {
    it('loads through ts-node and handles an empty audit window without local machine dependencies', () => {
        const tempDir = mkdtempSync(path.join(tmpdir(), 'recent-trade-loss-audit-'));
        const candlesDbPath = path.join(tempDir, 'candles.db');
        const db = new Database(candlesDbPath);
        db.exec(`
            CREATE TABLE ohlcv_data (
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL,
                buy_volume REAL
            )
        `);
        db.close();

        try {
            const output = execFileSync('node', [
                '-r',
                'ts-node/register',
                '-e',
                [
                    "const { auditRecentLosingTrades } = require('./src/tooling/aegis/recentTradeLossAuditCore');",
                    `auditRecentLosingTrades({ repoRoot: process.cwd(), candlesDbPath: ${JSON.stringify(candlesDbPath)}, symbols: ['ETHUSDT'], from: '2099-01-01', to: '2099-01-02', charts: false, writeReports: false })`,
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
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});