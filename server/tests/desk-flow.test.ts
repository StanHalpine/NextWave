import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { createSession } from '../src/lib/sessions.js';
import { app, makeAccount, signIn, signInFully } from './helpers.js';
import { makePatient, patch, post, TUESDAY_1007 } from './phase2.js';
import { frontDeskLogin, providerLogin, saveSoap, URL, visit } from './phase4.js';

/**
 * The front desk's day, end to end: a visit the provider has signed is SEEN, which is NOT finished. Nothing is recorded, and no
 * revenue exists, until the front desk checks the patient out. CHECKED_OUT (the screens' "done") is reachable only that way.
 *
 * Found on staging: a signed visit sat in "Seen / checked out" labelled "Done", with no Check out action, and Accounting empty for
 * the day. The server was right (it accepts check-out from SEEN); the screens gave SEEN no way to do it. See web/src/frontdesk.ts.
 */

beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));

const DASH = '/api/fd/dashboard?date=2026-10-13';
const CHECKOUT = (id: string) => `/api/fd/appointments/${id}/check-out`;
const notesOf = (bookingId: string) => basePrisma.visitNote.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } });
const encounterOf = (bookingId: string) => basePrisma.encounter.findUniqueOrThrow({ where: { bookingId } });
const revenueOf = (encounterId: string) => basePrisma.revenueEvent.findMany({ where: { encounterId } });

/** A checked-in visit with its own provider, a linked patient, and a drafted note — ready to sign. */
async function readyToSign() {
  const prov = await providerLogin('PROVIDER_CHIRO');
  const patient = await makePatient();
  const v = await visit({ staffId: prov.staff.id, doc: 'SOAP', patientId: patient.id });
  const version = await saveSoap(prov, v.booking.id);
  return { prov, patient, v, id: v.booking.id, version };
}
async function signed() {
  const r = await readyToSign();
  const s = await post(r.prov, URL.sign(r.id), { version: r.version });
  expect(s.status).toBe(201);
  return r;
}

describe('a signed visit is SEEN — not finished — and it is the front desk that finishes it', () => {
  it('signing moves CHECKED_IN to SEEN and nothing else: no check-out, no payment, no revenue', async () => {
    const { id } = await signed();
    const enc = await encounterOf(id);
    expect(enc.status).toBe('SEEN');
    expect(enc.seenAt).not.toBeNull();
    expect(enc.checkedOutAt).toBeNull();
    expect(enc.checkedOutById).toBeNull();
    expect(await revenueOf(enc.id)).toHaveLength(0);
  });

  it('amending the signed note leaves the visit exactly as it was: SEEN, unpaid', async () => {
    const { prov, id } = await signed();
    const [first] = await notesOf(id);
    const r = await post(prov, `/api/visit-notes/${first!.id}/amend`, { body: 'Corrected.', amendReason: 'Typo' });
    expect(r.status).toBe(201);
    const enc = await encounterOf(id);
    expect([enc.status, enc.checkedOutAt]).toEqual(['SEEN', null]);
    expect(await revenueOf(enc.id)).toHaveLength(0);
  });

  it('the desk sees it in the finished column, ahead of the visits that really are finished', async () => {
    const finished = await visit({ encounter: 'CHECKED_OUT' });     // created FIRST, so only the column's own ordering can put the unpaid visit ahead of it
    const { id } = await signed();
    const fd = await frontDeskLogin();
    const done = (await fd.agent.get(DASH)).body.done as Array<{ id: string; encounter: { status: string } }>;
    const at = (bookingId: string) => done.findIndex((a) => a.id === bookingId);
    expect(at(id)).toBeGreaterThanOrEqual(0);
    expect(at(finished.booking.id)).toBeGreaterThanOrEqual(0);
    expect(done[at(id)]!.encounter.status).toBe('SEEN');
    const lastSeen = done.map((a) => a.encounter.status).lastIndexOf('SEEN');
    const firstOut = done.findIndex((a) => a.encounter.status === 'CHECKED_OUT');
    expect(lastSeen).toBeLessThan(firstOut);                       // every unpaid SEEN visit leads the column
  });

  it('can be checked out: the preview opens, and check-out writes one revenue event and only then marks it CHECKED_OUT', async () => {
    const { id, patient } = await signed();
    const fd = await frontDeskLogin();

    const pv = await fd.agent.get(`/api/fd/appointments/${id}/checkout-preview`);
    expect(pv.status).toBe(200);
    expect(pv.body.preview).toMatchObject({ alreadyCheckedOut: false, patient: { id: patient.id } });

    const out = await post(fd, CHECKOUT(id), { payment: 'CASH', priceCents: 5500 });
    expect(out.status).toBe(200);
    expect(out.body.appointment.encounter.status).toBe('CHECKED_OUT');

    const enc = await encounterOf(id);
    expect(enc.status).toBe('CHECKED_OUT');
    expect(enc.checkedOutAt).not.toBeNull();
    const events = await revenueOf(enc.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ encounterId: enc.id, paymentType: 'CASH', listPriceCents: 5500, netPriceCents: 5500 });
    // and the dashboard now treats it as finished: nothing left to do
    const row = ((await fd.agent.get(DASH)).body.done as Array<{ id: string; encounter: { status: string } }>).find((a) => a.id === id);
    expect(row?.encounter.status).toBe('CHECKED_OUT');
  });

  it('a check-out that is refused leaves the visit SEEN and unpaid', async () => {
    const { id } = await signed();                                  // the service has no price: cash needs the amount typed
    const fd = await frontDeskLogin();
    const r = await post(fd, CHECKOUT(id), { payment: 'CASH' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const enc = await encounterOf(id);
    expect(enc.status).toBe('SEEN');
    expect(await revenueOf(enc.id)).toHaveLength(0);
  });
});

describe('CHECKED_OUT is reachable only through check-out, which always records the payment', () => {
  it('nothing else a visit goes through — start, draft, sign, amend, addendum, undo, no-show, a second check-in — checks it out', async () => {
    const { prov, id, version, v } = await readyToSign();
    const fd = await frontDeskLogin();
    const status = async () => (await encounterOf(id)).status;
    const never = async () => { expect(await status()).not.toBe('CHECKED_OUT'); expect(await revenueOf(v.encounter!.id)).toHaveLength(0); };

    await post(prov, URL.start(id)); await never();
    await post(prov, URL.sign(id), { version }); await never();
    const [note] = await notesOf(id);
    await post(prov, `/api/visit-notes/${note!.id}/amend`, { body: 'Again.', amendReason: 'why' }); await never();
    await post(prov, `/api/visit-notes/${note!.id}/addendum`, { body: 'More.' }); await never();
    await post(fd, `/api/fd/appointments/${id}/undo-check-in`); await never();       // refused: it has been seen
    await post(fd, `/api/fd/appointments/${id}/no-show`); await never();             // refused: it has started
    await post(fd, `/api/fd/appointments/${id}/check-in`); await never();            // refused: already under way
    expect(await status()).toBe('SEEN');

    expect((await post(fd, CHECKOUT(id), { payment: 'CASH', priceCents: 1000 })).status).toBe(200);
    expect(await status()).toBe('CHECKED_OUT');
    expect(await revenueOf(v.encounter!.id)).toHaveLength(1);
  });

  it('a double click records one payment, not two', async () => {
    const { id, v } = await signed();
    const fd = await frontDeskLogin();
    const [a, b] = await Promise.all([post(fd, CHECKOUT(id), { payment: 'CASH', priceCents: 2500 }), post(fd, CHECKOUT(id), { payment: 'CASH', priceCents: 2500 })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await revenueOf(v.encounter!.id)).toHaveLength(1);
  });

  it('in the code: only the check-out function writes CHECKED_OUT, and only the check-out library calls it', () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const n of readdirSync(dir)) { const p = path.join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
    walk('src');
    const read = (p: string) => readFileSync(p, 'utf8');
    const norm = (p: string) => p.split(path.sep).join('/');

    // anything that SETS or FILTERS on `status: 'CHECKED_OUT'` as data, or writes the Encounter table in SQL
    const writers = files.filter((p) => /status:\s*'CHECKED_OUT'/.test(read(p)));
    expect(writers.map(norm)).toEqual(['src/lib/encounters.ts']);
    expect(files.filter((p) => /UPDATE\s+"Encounter"|INSERT\s+INTO\s+"Encounter"/i.test(read(p))).map(norm)).toEqual([]);

    // checkOut() itself has exactly one caller: checkoutVisit, which writes the RevenueEvent in the same transaction
    const callers = files.filter((p) => /\bcheckOut\(/.test(read(p)) && !/export async function checkOut\(/.test(read(p))).map(norm);
    expect(callers).toEqual(['src/lib/checkout.ts']);
    const checkout = read('src/lib/checkout.ts');
    expect(checkout.indexOf('tx.revenueEvent.create')).toBeGreaterThan(-1);
  });
});

describe('editing your own roles on Admin → Accounts', () => {
  /** The administrator signed in on this browser, and the same account signed in on another device (a second session, authenticator done). */
  async function adminWithTwoSessions() {
    await makeAccount({ roles: ['ADMIN'] });                          // another admin, so this one may drop the role
    const me = await makeAccount({ roles: ['ADMIN'] });
    const here = await signInFully(me.email);                         // the browser making the change
    // A second sign-in would need another authenticator code, and one cannot be used twice in the same 30 seconds — so mint the session directly.
    const { token } = await createSession(me.id, { ip: null, userAgent: null, mfaVerified: true });
    const elsewhere = { agent: { get: (url: string) => request(app).get(url).set('Cookie', `nw_session=${token}`) } };
    return { me, here, elsewhere };
  }

  it('keeps the session it is made from, applies the new roles to it at once, and ends the account\'s other sign-ins', async () => {
    const { me, here, elsewhere } = await adminWithTwoSessions();
    const r = await patch(here, `/api/admin/accounts/${me.id}`, { roles: ['ADMIN', 'FRONT_DESK'] });
    expect(r.status).toBe(200);
    expect(r.body.sessionKept).toBe(true);

    const now = await here.agent.get('/api/auth/me');
    expect(now.status).toBe(200);
    expect([...now.body.account.roles].sort()).toEqual(['ADMIN', 'FRONT_DESK']);          // the new roles, without signing in again
    expect((await here.agent.get('/api/fd/dashboard')).status).toBe(200);                 // and they work: the desk is open to it now
    expect((await elsewhere.agent.get('/api/auth/me')).status).toBe(401);                 // the other device must sign in again
  });

  it('a role taken away takes effect on the kept session immediately', async () => {
    const { me, here } = await adminWithTwoSessions();
    expect((await patch(here, `/api/admin/accounts/${me.id}`, { roles: ['FRONT_DESK'] })).status).toBe(200);
    expect((await here.agent.get('/api/auth/me')).status).toBe(200);                      // still signed in …
    expect((await here.agent.get('/api/admin/accounts')).status).toBe(403);               // … but no longer an administrator
    expect((await here.agent.get('/api/fd/dashboard')).status).toBe(200);
  });

  it('someone else\'s roles changing still ends all of their sessions at once', async () => {
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    const other = await makeAccount({ roles: ['FRONT_DESK'] });
    const theirs = await signInFully(other.email);
    const r = await patch(admin, `/api/admin/accounts/${other.id}`, { roles: ['ADMIN'] });
    expect([r.status, r.body.sessionKept]).toEqual([200, false]);
    expect((await theirs.agent.get('/api/auth/me')).status).toBe(401);
  });

  it('a change that is not about roles (a name) ends nobody', async () => {
    const { me, here, elsewhere } = await adminWithTwoSessions();
    const r = await patch(here, `/api/admin/accounts/${me.id}`, { displayName: 'New Name' });
    expect([r.status, r.body.sessionKept]).toEqual([200, false]);
    expect((await elsewhere.agent.get('/api/auth/me')).status).toBe(200);
  });

  it('still cannot be used to keep a session on an account that was never signed in', async () => {
    // a sanity check on the exemption: it is the ACTING session's id, so a request with no session is refused outright
    const me = await makeAccount({ roles: ['ADMIN'] });
    expect((await request(app).patch(`/api/admin/accounts/${me.id}`).send({ roles: ['FRONT_DESK'] })).status).toBe(401);
    const s = await signIn(me.email);                                                     // password only, authenticator not yet done
    expect((await patch(s, `/api/admin/accounts/${me.id}`, { roles: ['FRONT_DESK'] })).status).toBe(403);
  });
});
