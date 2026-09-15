import { describe, expect, it } from 'vitest';
import { auditHistoricalExport } from './MicroBurstHistoricalExportAudit';

describe('Micro historical export audit', () => {
  it('groups target symbols and exposes identifiers without changing source rows', () => {
    const rows = [
      { symbol: 'SUIUSDT', orderId: 123, clientOrderId: 'se_entry' },
      { Symbol: 'DOGEUSDT', orderID: '456', clientOrderID: 'se_close' },
      { symbol: 'BTCUSDT', orderId: 789 },
      { side: 'BUY' },
    ];
    expect(auditHistoricalExport(rows, 'fixture.json')).toEqual({
      source: 'fixture.json',
      symbols: {
        SUIUSDT: { rows: 1, orderIds: ['123'], clientOrderIds: ['se_entry'] },
        DOGEUSDT: { rows: 1, orderIds: ['456'], clientOrderIds: ['se_close'] },
      },
      unsupportedRows: 1,
      malformedRows: 1,
      warnings: [
        'SOLUSDT: no matching rows in export',
        'LINKUSDT: no matching rows in export',
        'BNBUSDT: no matching rows in export',
        'LTCUSDT: no matching rows in export',
        'AVAXUSDT: no matching rows in export',
        'XRPUSDT: no matching rows in export',
      ],
    });
  });
});
