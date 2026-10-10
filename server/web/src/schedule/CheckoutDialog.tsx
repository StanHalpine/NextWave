import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, Modal, Notice } from '../ui';
import { credits as creditsLabel, fmtMoney, fmtTime12, memberDiscount, parseDollars } from '../lib';
import type { Appt, CheckoutPreview, CheckoutResult } from '../types';

type Choice = { kind: 'CREDITS' } | { kind: 'PERK'; perkId: string } | { kind: 'CASH' };
const PERIOD_WORD: Record<string, string> = { MONTHLY: 'month', QUARTERLY: 'quarter', ANNUAL: 'year' };

/**
 * Check-out: how was this visit paid? Shows the price, the member's balance before and after,
 * and every option, with the reason when credits aren't one. Cash is RECORDED — nothing is charged here.
 */
export function CheckoutDialog({ appt, onClose, onDone }: { appt: Appt; onClose: () => void; onDone: () => void }) {
  const [pv, setPv] = useState<CheckoutPreview | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckoutResult | null>(null);

  useEffect(() => {
    api<{ preview: CheckoutPreview }>(`/api/fd/appointments/${appt.id}/checkout-preview`)
      .then((r) => {
        setPv(r.preview);
        // The member-friendly default: credits if they cover it, else an included perk, else cash.
        setChoice(r.preview.credits.available ? { kind: 'CREDITS' } : r.preview.perks[0] ? { kind: 'PERK', perkId: r.preview.perks[0].perkId } : { kind: 'CASH' });
      })
      .catch((e) => setError(errorText(e)));
  }, [appt.id]);

  const typed = parseDollars(amount);
  const cashNeedsAmount = pv ? !pv.cash.priceKnown : false;
  // What a cash payment comes to: the list price (set, or as typed), less the member discount if one applies.
  const cashList = pv ? (pv.cash.priceKnown ? pv.cash.priceCents : typed) : null;
  const cashPct = pv?.cash.discountPercent ?? 0;
  const cashSplit = cashList != null ? memberDiscount(cashList, cashPct) : null;
  const ready = !!choice && (choice.kind !== 'CASH' || !cashNeedsAmount || typed !== null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!choice || !pv) return;
    setBusy(true); setError(null);
    try {
      const body = choice.kind === 'CREDITS' ? { payment: 'CREDITS' } : choice.kind === 'PERK' ? { payment: 'PERK', perkId: choice.perkId }
        : { payment: 'CASH', ...(cashNeedsAmount && typed ? { priceCents: typed } : {}), ...(cashSplit ? { expectedNetCents: cashSplit.netCents } : {}) };
      const r = await api<{ checkout: CheckoutResult }>(`/api/fd/appointments/${appt.id}/check-out`, { method: 'POST', body });
      setResult(r.checkout);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  if (result) return <Receipt appt={appt} r={result} onClose={() => { onDone(); onClose(); }} />;

  return (
    <Modal title="Check out" wide onClose={onClose}>
      {!pv && !error && <p className="muted">Loading…</p>}
      {error && <Notice kind="error">{error}</Notice>}
      {pv?.alreadyCheckedOut && <Notice>This visit has already been checked out.</Notice>}
      {pv && !pv.alreadyCheckedOut && (
        <form className="stack" onSubmit={(e) => void submit(e)}>
          <div className="checkout-head">
            <div>
              <strong>{pv.patient?.name ?? appt.patient.name}</strong>
              <div className="muted">{pv.service.name}{pv.service.subOption ? ` · ${pv.service.subOption}` : ''} · {fmtTime12(appt.localStart)}</div>
            </div>
            <div className="price">{pv.listPriceCents != null ? fmtMoney(pv.listPriceCents) : <span className="muted">no set price</span>}</div>
          </div>

          <div className="member-line">
            {pv.membership
              ? <><span className="pill ok">{pv.membership.planName}</span> {pv.membership.status !== 'ACTIVE' && <span className="pill warn">{pv.membership.status.toLowerCase()}</span>} <strong>{pv.balance}</strong> {pv.balance === 1 ? 'credit' : 'credits'} available</>
              : pv.patient ? <><span className="pill off">not a member</span> {pv.balance ? <><strong>{pv.balance}</strong> credits left from a past membership</> : null}</> : <span className="muted">No patient record linked.</span>}
          </div>

          <div className="pay-options" role="radiogroup" aria-label="How was this visit paid?">
            <label className={`pay-option${choice?.kind === 'CREDITS' ? ' on' : ''}${!pv.credits.available ? ' disabled' : ''}`}>
              <input type="radio" name="pay" disabled={!pv.credits.available} checked={choice?.kind === 'CREDITS'} onChange={() => setChoice({ kind: 'CREDITS' })} />
              <span>
                <strong>Wellness Credits</strong>{pv.credits.cost != null && <> — {creditsLabel(pv.credits.cost)}</>}
                <br />
                {pv.credits.available
                  ? <span className="balance-change">Balance {pv.balance} → <strong>{pv.credits.balanceAfter}</strong></span>
                  : <span className="muted small">{pv.credits.reason}</span>}
              </span>
            </label>

            {pv.perks.map((k) => (
              <label key={k.perkId} className={`pay-option${choice?.kind === 'PERK' && choice.perkId === k.perkId ? ' on' : ''}`}>
                <input type="radio" name="pay" checked={choice?.kind === 'PERK' && choice.perkId === k.perkId} onChange={() => setChoice({ kind: 'PERK', perkId: k.perkId })} />
                <span><strong>Included with membership: {k.label}</strong><br /><span className="muted small">{k.remaining} left this {PERIOD_WORD[k.period] ?? k.period}</span></span>
              </label>
            ))}

            <label className={`pay-option${choice?.kind === 'CASH' ? ' on' : ''}`}>
              <input type="radio" name="pay" checked={choice?.kind === 'CASH'} onChange={() => setChoice({ kind: 'CASH' })} />
              <span>
                <strong>Paid at the desk</strong>{cashSplit && <> — {fmtMoney(cashSplit.netCents)}</>}
                {cashSplit && cashPct > 0 && (
                  <><br /><span className="small">{fmtMoney(cashList)} list − {cashPct}% {pv.membership?.planName} member discount ({fmtMoney(cashSplit.discountCents)}) = <strong>{fmtMoney(cashSplit.netCents)}</strong></span></>
                )}
                <br /><span className="muted small">Recorded only — nothing is charged from here.</span>
              </span>
            </label>
          </div>

          {choice?.kind === 'CASH' && cashNeedsAmount && (
            <label>Price before any member discount ($)
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 75.00" autoFocus />
              <span className="hint">{pv.priceNote ?? 'This service has no set price'} — enter the full price; a member discount, if any, is taken off for you.</span>
            </label>
          )}

          {error && <p className="error" role="alert">{error}</p>}
          <div className="sheet-actions">
            <button className="btn primary" disabled={!ready || busy}>{busy ? 'Checking out…' : 'Check out'}</button>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function Receipt({ appt, r, onClose }: { appt: Appt; r: CheckoutResult; onClose: () => void }) {
  return (
    <Modal title="Checked out" onClose={onClose}>
      <div className="stack">
        <p><strong>{appt.patient.name}</strong> · {appt.service.name}</p>
        <dl className="facts">
          <dt>Paid with</dt>
          <dd>
            {r.paymentType === 'CASH' ? <>At the desk — <strong>{fmtMoney(r.netPriceCents)}</strong></>
              : r.memberBenefit === 'PERK' ? <>Included perk{r.perkLabel ? `: ${r.perkLabel}` : ''}</>
              : <><strong>{creditsLabel(r.creditsRedeemed)}</strong></>}
          </dd>
          {r.paymentType === 'CASH' && r.discountPercent > 0 && (<><dt>Member discount</dt><dd>{r.discountPercent}% off {fmtMoney(r.listPriceCents)} = −{fmtMoney(r.discountCents)}</dd></>)}
          {r.balanceBefore != null && r.balanceAfter != null && (<><dt>Balance</dt><dd>{r.balanceBefore} → <strong>{r.balanceAfter}</strong> {r.balanceAfter === 1 ? 'credit' : 'credits'}</dd></>)}
          {r.alreadyCheckedOut && (<><dt /><dd className="muted">Already checked out — nothing changed.</dd></>)}
        </dl>
        <div className="sheet-actions"><button className="btn primary" autoFocus onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}
