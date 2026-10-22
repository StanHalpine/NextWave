import { describe, expect, it } from 'vitest';
import { overlapWarning, providerLine, type ProviderOption } from './coveringProvider';

const option = (over: Partial<ProviderOption> = {}): ProviderOption => ({ id: 's', name: 'Dr. Stan', role: 'CHIROPRACTOR', isCurrent: false, isScheduled: false, overlaps: [], ...over });

describe('the covering provider, as the desk sees it (rev 2.1)', () => {
  it('names the covering provider and who they cover for; otherwise the booked one', () => {
    expect(providerLine({ staff: { name: 'Dr. Chase' }, covering: { name: 'Dr. Stan' } })).toBe('Dr. Stan (covering for Dr. Chase)');
    expect(providerLine({ staff: { name: 'Dr. Chase' }, covering: null })).toBe('Dr. Chase');
    expect(providerLine({ staff: null, covering: { name: 'Dr. Stan' } })).toBe('Dr. Stan');
    expect(providerLine({ staff: null, covering: null })).toBe('No provider');
  });

  it('warns about the chosen provider\'s other appointments at that time — never refuses, and says nothing when there are none', () => {
    expect(overlapWarning(option())).toBeNull();
    expect(overlapWarning(option({ isCurrent: true, overlaps: [{ bookingId: 'b', localStart: '10:00', localEnd: '10:30', service: 'Adjustment', patient: 'Cara L', status: 'CONFIRMED', asCovering: false }] }))).toBeNull();
    const w = overlapWarning(option({
      overlaps: [
        { bookingId: 'b1', localStart: '09:45', localEnd: '10:15', service: 'Manual Adjustment', patient: 'Cara L', status: 'CONFIRMED', asCovering: false },
        { bookingId: 'b2', localStart: '10:15', localEnd: '10:45', service: 'Spinal Exam', patient: 'Dee H', status: 'PENDING_REVIEW', asCovering: true },
      ],
    }))!;
    expect(w).toBe('Dr. Stan also has 9:45 AM–10:15 AM Manual Adjustment (Cara L); 10:15 AM–10:45 AM Spinal Exam (Dee H, covering, awaiting approval) at this time. You can still choose them; the Schedule is not changed.');
  });
});
