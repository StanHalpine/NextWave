import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { errorText, Modal, Notice } from '../ui';
import { credits as creditsLabel, fmtDayLong, fmtMoney, fmtInstantTime } from '../lib';
import { useClinicTz } from '../clinic';
import { ADJUSTMENT_REASON_LABEL, type CreditsView, type LedgerEntry, type LotView, type PerkView, type PlanLite } from '../types';

const PERIOD_WORD = { MONTHLY: 'month', QUARTERLY: 'quarter', ANNUAL: 'year' } as const;
const STATUS_PILL: Record<LotView['status'], { cls: string; text: string }> = {
  ACTIVE: { cls: 'ok', text: 'usable' }, LAPSED: { cls: 'warn', text: 'expired — being written off' }, USED: { cls: 'off', text: 'used up' }, EXPIRED: { cls: 'off', text: 'expired' },
};

/** The Credit Tracker tab: membership, balance, lots, perks, full history, and (admin) manual adjustment. */
export default function CreditTracker({ patientId }: { patientId: string }) {
  const { hasRole } = useAuth();
  const tz = useClinicTz();
  const [data, setData] = useState<CreditsView | null>(null);
  const [older, setOlder] = useState<LedgerEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'enroll' | 'change'>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<CreditsView>(`/api/fd/patients/${patientId}/credits`);
      setData(r); setOlder([]); setNextBefore(r.history.nextBefore); setError(null);
    } catch (e) { setError(errorText(e)); }
  }, [patientId]);
  useEffect(() => { void load(); }, [load]);

  async function loadOlder() {
    if (!nextBefore) return;
    try {
      const r = await api<CreditsView>(`/api/fd/patients/${patientId}/credits?before=${nextBefore}`);
      setOlder((o) => [...o, ...r.history.entries]); setNextBefore(r.history.nextBefore);
    } catch (e) { setError(errorText(e)); }
  }

  async function membershipAction(action: 'pause' | 'resume' | 'cancel') {
    if (action === 'cancel' && !window.confirm('Cancel this membership? No more credits are granted. Credits already granted can still be used until they expire.')) return;
    setBusy(true); setNote(null);
    try { await api(`/api/fd/patients/${patientId}/membership`, { method: 'PATCH', body: { action } }); await load(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function usePerk(p: PerkView) {
    setBusy(true); setNote(null);
    try {
      const r = await api<{ remaining: number }>(`/api/fd/patients/${patientId}/perks/${p.perkId}/use`, { method: 'POST', body: {} });
      setNote(`${p.label}: used. ${r.remaining} left this ${PERIOD_WORD[p.period]}.`); await load();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  if (error && !data) return <Notice kind="error">{error}</Notice>;
  if (!data) return <p className="muted">Loading…</p>;
  const m = data.membership;
  const history = [...data.history.entries, ...older];

  return (
    <div className="stack">
      {error && <Notice kind="error">{error}</Notice>}
      {note && <Notice>{note}</Notice>}

      <div className="cards-2">
        <section className="card wide-card">
          <h2>Membership</h2>
          {m ? (
            <>
              <p className="plan-line"><strong>{m.plan.name}</strong> <span className={`pill ${m.status === 'ACTIVE' ? 'ok' : m.status === 'PAUSED' ? 'warn' : 'off'}`}>{m.status.toLowerCase()}</span></p>
              <dl className="facts">
                <dt>Dues</dt><dd>{fmtMoney(m.plan.priceCents, { whole: true })} / month <span className="muted small">(collected outside this system)</span></dd>
                <dt>Credits</dt><dd>{m.plan.creditsPerMonth} each month · roll over {m.plan.rolloverDays} days</dd>
                <dt>Discount</dt><dd>{m.plan.discountPercent > 0 ? <>{m.plan.discountPercent}% off list price when paying cash{m.status !== 'ACTIVE' && <span className="muted small"> (not while {m.status.toLowerCase()})</span>}</> : <span className="muted">none set for this tier</span>}</dd>
                <dt>Member since</dt><dd>{fmtDayLong(m.startedOn)}</dd>
                <dt>Next grant</dt><dd>{m.status === 'ACTIVE' ? fmtDayLong(m.nextGrantOn) : <span className="muted">none while {m.status.toLowerCase()}</span>}</dd>
              </dl>
              <div className="sheet-actions">
                <button className="btn small" disabled={busy} onClick={() => setDialog('change')}>Change plan…</button>
                {m.status === 'ACTIVE' && <button className="btn small" disabled={busy} onClick={() => void membershipAction('pause')}>Pause</button>}
                {m.status === 'PAUSED' && <button className="btn small primary" disabled={busy} onClick={() => void membershipAction('resume')}>Resume</button>}
                <button className="btn small" disabled={busy} onClick={() => void membershipAction('cancel')}>Cancel membership</button>
              </div>
              <p className="hint">A plan change applies from the next grant; nothing is prorated or taken back.</p>
            </>
          ) : (
            <>
              <p className="muted">Not a member. Non-members pay cash at check-out.</p>
              <button className="btn primary" onClick={() => setDialog('enroll')}>Enroll in a plan…</button>
              <p className="hint">Enrolling grants the first month’s credits at once. Dues are collected outside this system — nothing here takes payment.</p>
            </>
          )}
        </section>

        <section className="card wide-card balance-card" aria-label="Credit balance">
          <h2>Balance</h2>
          <div className="big-number" aria-live="polite">{data.balance}</div>
          <div className="muted">Wellness {data.balance === 1 ? 'Credit' : 'Credits'} you can use today</div>
          {data.expiringSoon && (
            <p className="expiring">⚠ {creditsLabel(data.expiringSoon.credits)} expire by {fmtDayLong(data.expiringSoon.on)}.</p>
          )}
        </section>
      </div>

      {data.perks.length > 0 && (
        <section>
          <h2>Included perks</h2>
          <table className="table">
            <thead><tr><th>Perk</th><th>Counted per</th><th>Used</th><th>Left</th><th /></tr></thead>
            <tbody>
              {data.perks.map((p) => (
                <tr key={p.perkId}>
                  <td>{p.label}{p.services.length > 0 && <span className="muted small"><br />{p.services.join(', ')}</span>}</td>
                  <td>{PERIOD_WORD[p.period]} <span className="muted small">({p.periodKey})</span></td>
                  <td>{p.used} of {p.quantity}</td>
                  <td><strong>{p.remaining}</strong></td>
                  <td>{p.usedAtCheckout ? <span className="muted small">used at check-out</span> : <button className="btn small" disabled={busy || p.remaining < 1 || m?.status !== 'ACTIVE'} onClick={() => void usePerk(p)}>Use one</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2>Credit lots</h2>
        <p className="hint">Each monthly grant is its own lot with its own last day. Credits are spent from the oldest lot first.</p>
        <table className="table">
          <thead><tr><th>Granted</th><th>Last day to use</th><th>Granted</th><th>Used</th><th>Expired</th><th>Left</th><th>Status</th></tr></thead>
          <tbody>
            {data.lots.map((l) => (
              <tr key={l.id} className={l.status === 'USED' || l.status === 'EXPIRED' ? 'off' : ''}>
                <td>{l.source === 'MONTHLY_GRANT' && l.period ? `Monthly grant · ${fmtDayLong(l.period)}` : `Added ${fmtDayLong(l.grantedOn)}`}</td>
                <td>{fmtDayLong(l.expiresOn)}</td>
                <td>{l.granted}</td><td>{l.redeemed + l.removed}</td><td>{l.expired}</td><td><strong>{l.remaining}</strong></td>
                <td><span className={`pill ${STATUS_PILL[l.status].cls}`}>{STATUS_PILL[l.status].text}</span></td>
              </tr>
            ))}
            {data.lots.length === 0 && <tr><td colSpan={7} className="muted">No credits have ever been granted.</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h2>History</h2>
        <table className="table dense">
          <thead><tr><th>When</th><th>What</th><th>Credits</th><th>Running total</th><th>By</th></tr></thead>
          <tbody>
            {history.map((e) => (
              <tr key={e.id}>
                <td>{fmtDayLong(e.date)}<br /><span className="muted small">{fmtInstantTime(e.at, tz)}</span></td>
                <td>{describe(e)}</td>
                <td className={e.delta > 0 ? 'plus' : 'minus'}>{e.delta > 0 ? `+${e.delta}` : e.delta}</td>
                <td>{e.runningTotal}</td>
                <td className="muted">{e.by ?? (e.reason === 'REDEMPTION' ? '—' : 'system')}</td>
              </tr>
            ))}
            {history.length === 0 && <tr><td colSpan={5} className="muted">Nothing yet.</td></tr>}
          </tbody>
        </table>
        {nextBefore && <button className="btn small" onClick={() => void loadOlder()}>Show older</button>}
        <p className="hint">The running total is the ledger’s own sum. It matches the balance once expired credits have been written off (the nightly job does this).</p>
      </section>

      {hasRole('ADMIN') && <AdjustCard patientId={patientId} onDone={load} />}

      {dialog && (
        <PlanDialog mode={dialog} current={m?.plan.code ?? null} patientId={patientId} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }} />
      )}
    </div>
  );
}

function describe(e: LedgerEntry): string {
  switch (e.reason) {
    case 'MONTHLY_GRANT': return 'Monthly grant';
    case 'REDEMPTION': return e.service ? `Used at a visit: ${e.service}` : 'Used at a visit';
    case 'EXPIRATION': return 'Expired';
    case 'ADJUSTMENT': return `Adjustment${e.reasonCode ? ` — ${ADJUSTMENT_REASON_LABEL[e.reasonCode] ?? e.reasonCode}` : ''}`;
  }
}

// ---- manual adjustment (admin) ------------------------------------------------------------------

function AdjustCard({ patientId, onDone }: { patientId: string; onDone: () => Promise<void> }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const n = Number(amount);
  const valid = Number.isInteger(n) && n !== 0 && reason !== '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ balanceBefore: number; balanceAfter: number }>(`/api/fd/patients/${patientId}/credits/adjust`, { method: 'POST', body: { amount: n, reasonCode: reason } });
      setMsg({ kind: 'ok', text: `Done. Balance ${r.balanceBefore} → ${r.balanceAfter}.` });
      setAmount(''); setReason(''); await onDone();
    } catch (err) { setMsg({ kind: 'error', text: errorText(err) }); }
    finally { setBusy(false); }
  }

  return (
    <form className="card wide-card" onSubmit={(e) => void submit(e)}>
      <h2>Adjust credits <span className="tag">admin</span></h2>
      <p className="hint">Adds a new lot (a positive number) or removes credits oldest-first (a negative number). Every adjustment is recorded with who made it and a reason. Choose a reason — don’t type health details anywhere.</p>
      <div className="inline-row">
        <label>Credits (+ add, − remove)
          <input type="number" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 2 or -1" />
        </label>
        <label>Reason
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">— choose —</option>
            {Object.entries(ADJUSTMENT_REASON_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        <button className="btn" disabled={!valid || busy}>{busy ? 'Saving…' : 'Apply adjustment'}</button>
      </div>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok-text'} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</p>}
    </form>
  );
}

// ---- enrol / change plan ------------------------------------------------------------------------

function PlanDialog({ mode, current, patientId, onClose, onDone }: { mode: 'enroll' | 'change'; current: string | null; patientId: string; onClose: () => void; onDone: () => void }) {
  const [plans, setPlans] = useState<PlanLite[]>([]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<{ plans: PlanLite[] }>('/api/membership-plans').then((r) => setPlans(r.plans)).catch((e) => setError(errorText(e))); }, []);
  const chosen = plans.find((p) => p.code === code);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (mode === 'enroll') await api(`/api/fd/patients/${patientId}/membership`, { method: 'POST', body: { planCode: code } });
      else await api(`/api/fd/patients/${patientId}/membership`, { method: 'PATCH', body: { action: 'change_plan', planCode: code } });
      onDone();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={mode === 'enroll' ? 'Enroll in a plan' : 'Change plan'} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <div className="plan-choices" role="radiogroup" aria-label="Plan">
          {plans.filter((p) => p.code !== current).map((p) => (
            <label key={p.code} className={`plan-choice${code === p.code ? ' on' : ''}`}>
              <input type="radio" name="plan" value={p.code} checked={code === p.code} onChange={() => setCode(p.code)} />
              <span><strong>{p.name}</strong> — {fmtMoney(p.priceCents, { whole: true })}/mo<br /><span className="muted small">{p.creditsPerMonth} credits a month, roll over {p.rolloverDays} days</span></span>
            </label>
          ))}
        </div>
        {chosen && (
          <p className="hint">
            {mode === 'enroll'
              ? `${chosen.creditsPerMonth} credits are granted now, then on the same day each month. Dues of ${fmtMoney(chosen.priceCents, { whole: true })}/month are collected outside this system.`
              : `Takes effect at the next grant (${chosen.creditsPerMonth} credits). Nothing is granted or taken back now.`}
          </p>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="sheet-actions">
          <button className="btn primary" disabled={!code || busy}>{busy ? 'Saving…' : mode === 'enroll' ? 'Enroll' : 'Change plan'}</button>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
