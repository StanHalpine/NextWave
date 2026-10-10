import { describe, expect, it } from 'vitest';
import { clock, insertMacro, isBlank, macrosFor, missingSections, parseMinutes, pickAudioType, scribeFailure, signBlockers } from './docs';
import type { MacroLite } from '../types';

describe('what blocks signing', () => {
  const full = { subjective: 's', objective: 'o', assessment: 'a', plan: 'p' };
  it('needs all four SOAP sections, treating whitespace as empty', () => {
    expect(missingSections(full)).toEqual([]);
    expect(missingSections({ ...full, objective: '   \n ', plan: '' })).toEqual(['objective', 'plan']);
    expect(signBlockers('SOAP', full, { notes: '', durationMin: null })).toEqual([]);
    expect(signBlockers('SOAP', { ...full, plan: '' }, { notes: '', durationMin: null })[0]).toMatch(/Plan/);
    expect(isBlank(' \t\n')).toBe(true);
    expect(isBlank(' N/A ')).toBe(false);
  });
  it('needs a session log\'s duration and notes', () => {
    expect(signBlockers('SESSION_LOG', full, { notes: 'ok', durationMin: 20 })).toEqual([]);
    expect(signBlockers('SESSION_LOG', full, { notes: ' ', durationMin: null })).toHaveLength(2);
    expect(signBlockers('SESSION_LOG', full, { notes: 'ok', durationMin: null })).toEqual(['Enter how long the session lasted']);
  });
});

describe('parseMinutes', () => {
  it('accepts whole minutes 1–1440, treats blank as not entered, and rejects the rest', () => {
    expect(parseMinutes('25')).toBe(25);
    expect(parseMinutes(' 1440 ')).toBe(1440);
    expect(parseMinutes('')).toBeNull();
    for (const bad of ['0', '1441', '-5', '12.5', 'abc', '2e2', '12345']) expect(parseMinutes(bad), bad).toBeUndefined();
  });
});

describe('insertMacro', () => {
  it('puts the text in an empty box as it is', () => {
    expect(insertMacro('', 0, 0, 'Stretch daily.')).toEqual({ text: 'Stretch daily.', cursor: 14 });
  });
  it('starts a new paragraph after existing text, so macros never run together', () => {
    expect(insertMacro('First.', 6, 6, 'Second.')).toEqual({ text: 'First.\n\nSecond.', cursor: 15 });
    expect(insertMacro('First.\n', 7, 7, 'Second.')).toEqual({ text: 'First.\n\nSecond.', cursor: 15 });
    expect(insertMacro('First.\n\n', 8, 8, 'Second.')).toEqual({ text: 'First.\n\nSecond.', cursor: 15 });
  });
  it('inserts at the cursor in the middle, separating both sides, and replaces a selection', () => {
    const r = insertMacro('Before. After.', 7, 7, 'MID');
    expect(r.text).toBe('Before.\n\nMID\n\nAfter.');
    expect(r.text.slice(0, r.cursor).endsWith('MID')).toBe(true);
    expect(insertMacro('keep DELETE keep', 5, 11, 'NEW').text).toBe('keep\n\nNEW\n\nkeep');
  });
  it('tolerates a cursor outside the text', () => {
    expect(insertMacro('abc', 99, 120, 'X').text).toBe('abc\n\nX');
    expect(insertMacro('abc', -4, -1, 'X').text).toBe('X\n\nabc');
  });
});

describe('macrosFor', () => {
  const m = (id: string, section: MacroLite['section'], title = id): MacroLite => ({ id, section, title, body: 'b', sortOrder: 0 });
  it('picks one section, shared first and kept apart from the provider\'s own', () => {
    const r = macrosFor('PLAN', [{ macros: [m('s1', 'PLAN'), m('s2', 'SUBJECTIVE')] }, { macros: [m('s3', 'PLAN')] }], [m('p1', 'PLAN'), m('p2', 'OBJECTIVE')]);
    expect(r.shared.map((x) => x.id)).toEqual(['s1', 's3']);
    expect(r.personal.map((x) => x.id)).toEqual(['p1']);
  });
});

describe('small formatters', () => {
  it('formats a recording clock', () => {
    expect([clock(0), clock(5), clock(65), clock(3600), clock(-3), clock(59.9)]).toEqual(['0:00', '0:05', '1:05', '60:00', '0:00', '0:59']);
  });
  it('picks the best recording format the browser supports, else lets it choose', () => {
    expect(pickAudioType(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickAudioType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickAudioType(() => false)).toBe('');
  });
  it('explains a failed recording without the provider\'s own words', () => {
    expect(scribeFailure('transcribe_failed')).toMatch(/transcribed/);
    expect(scribeFailure('draft_failed')).toMatch(/drafted/);
    expect(scribeFailure('timed_out')).toMatch(/too long/);
    expect(scribeFailure(null)).toMatch(/Something went wrong/);
  });
});

describe('note order and role names', () => {
  it('shows SOAP notes in S, O, A, P order whatever order they arrive in', async () => {
    const { inNoteOrder } = await import('./docs');
    const kinds = inNoteOrder([{ kind: 'PLAN' }, { kind: 'SUBJECTIVE' }, { kind: 'ASSESSMENT' }, { kind: 'OBJECTIVE' }]).map((n) => n.kind);
    expect(kinds).toEqual(['SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN']);
    expect(inNoteOrder([{ kind: 'GENERAL', id: 1 }, { kind: 'GENERAL', id: 2 }]).map((n: any) => n.id)).toEqual([1, 2]);   // stable
  });
  it('names a role from either its login role or its staff role', async () => {
    const { roleName } = await import('./docs');
    expect([roleName('PROVIDER_NP'), roleName('NURSE_PRACTITIONER'), roleName('REGISTERED_NURSE'), roleName('CHIROPRACTOR'), roleName('weird')]).toEqual(['Nurse practitioner', 'Nurse practitioner', 'Nurse', 'Chiropractor', 'weird']);
  });
});
