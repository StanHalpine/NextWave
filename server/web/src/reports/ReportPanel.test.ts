import { describe, expect, it } from 'vitest';
import { formatCell, rangeIsValid, reportQuery } from './ReportPanel';

describe('report cells', () => {
  it('shows money from whole cents, counts with thousands separators, and leaves text alone', () => {
    expect(formatCell('money', 0)).toBe('$0.00');
    expect(formatCell('money', 1999)).toBe('$19.99');
    expect(formatCell('money', 1234567)).toBe('$12,345.67');
    expect(formatCell('money', -250)).toBe('-$2.50');
    expect(formatCell('int', 12345)).toBe('12,345');
    expect(formatCell('percent', 12.5)).toBe('12.5%');
    expect(formatCell('text', 'Member — cash')).toBe('Member — cash');
    expect(formatCell('money', '')).toBe('');
    expect(formatCell('int', undefined)).toBe('');
  });
});

describe('the report query', () => {
  it('sends no dates until a range is chosen, so the server picks the current month in the clinic calendar', () => {
    expect(reportQuery(null)).toBe('');
    expect(reportQuery(null, { serviceId: '', group: 'day' })).toBe('group=day');
  });

  it('carries the chosen range, the view\'s filters (empty ones left out) and the export format', () => {
    expect(reportQuery({ from: '2026-10-01', to: '2026-10-31' }, { serviceId: 'a1', paymentType: '' })).toBe('serviceId=a1&from=2026-10-01&to=2026-10-31');
    expect(reportQuery({ from: '2026-10-01', to: '2026-10-31' }, {}, 'csv')).toBe('from=2026-10-01&to=2026-10-31&format=csv');
  });

  it('accepts a range only when both ends are real-looking dates in order', () => {
    expect(rangeIsValid('2026-10-01', '2026-10-31')).toBe(true);
    expect(rangeIsValid('2026-10-05', '2026-10-05')).toBe(true);
    expect(rangeIsValid('2026-10-06', '2026-10-05')).toBe(false);
    expect(rangeIsValid('', '2026-10-05')).toBe(false);
    expect(rangeIsValid('10/01/2026', '10/31/2026')).toBe(false);
  });
});
