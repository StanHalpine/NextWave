import { describe, expect, it } from 'vitest';
import { NOTE_LABEL, NOTE_PILL, NOTE_SHORT, noteText, unsignedLinkLabel, visitLabel, waitedFor, worklistSummary } from './notes';

describe('the words for a visit\'s note (rev 2.0)', () => {
  it('names each status the same everywhere, pending as a warning and never as a refusal to check out', () => {
    expect(NOTE_LABEL).toEqual({ NOT_REQUIRED: 'No note needed', PENDING: 'Note pending', SIGNED: 'Note signed' });
    expect(NOTE_PILL).toEqual({ NOT_REQUIRED: 'off', PENDING: 'warn', SIGNED: 'ok' });
    expect(Object.values(NOTE_SHORT)).toEqual(['No note', 'Note pending', 'Signed']);
    for (const t of [...Object.values(NOTE_LABEL), ...Object.values(NOTE_SHORT)]) expect(t).not.toMatch(/check.?out|wait|block/i);
  });

  it('says a pending note has a draft started; a draft on a signed or not-needed note changes nothing', () => {
    expect(noteText('PENDING', 'DRAFT')).toBe('Note pending — draft started');
    expect(noteText('PENDING', 'NONE')).toBe('Note pending');
    expect(noteText('SIGNED', 'SIGNED')).toBe('Note signed');
    expect(noteText('NOT_REQUIRED', 'DRAFT')).toBe('No note needed');
  });
});

describe('the Unsigned notes worklist', () => {
  it('says how long a note has waited in hours, then days', () => {
    expect([waitedFor(0), waitedFor(1), waitedFor(23), waitedFor(47), waitedFor(48), waitedFor(50), waitedFor(72)])
      .toEqual(['under 1 h', '1 h', '23 h', '47 h', '2 d', '2 d 2 h', '3 d']);
  });

  it('summarises the list with the threshold it was measured against', () => {
    expect(worklistSummary(0, 0, 24)).toBe('No unsigned notes');
    expect(worklistSummary(1, 0, 24)).toBe('1 unsigned note');
    expect(worklistSummary(5, 2, 24)).toBe('5 unsigned notes · 2 pending more than 24 hours');
    expect(worklistSummary(5, 2, 48)).toMatch(/more than 48 hours$/);
  });

  it('labels the Provider page\'s link with the provider\'s own counts, or asks an account with no provider record to choose', () => {
    expect(unsignedLinkLabel(null)).toBe('Unsigned notes by provider');
    expect(unsignedLinkLabel({ count: 0, overdue: 0 })).toBe('Your unsigned notes: none');
    expect(unsignedLinkLabel({ count: 12, overdue: 0 })).toBe('Your unsigned notes: 12');
    expect(unsignedLinkLabel({ count: 12, overdue: 3 })).toBe('Your unsigned notes: 12 (3 overdue)');
  });

  it('says where each listed visit is', () => {
    expect(['CHECKED_IN', 'IN_PROGRESS', 'SEEN', 'CHECKED_OUT'].map((s) => visitLabel(s as never))).toEqual(['Checked in', 'With provider', 'Seen', 'Checked out']);
  });
});
