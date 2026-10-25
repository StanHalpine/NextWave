import { deskActions, type DeskContext, type DeskVerb } from '../frontdesk';
import type { Appt } from '../types';

/** The front-desk buttons for one appointment (see frontdesk.ts for which, and why). Shared by the card and the dialog. */
export function DeskActions({ a, ctx, busy, onVerb, onCheckout, onLink, onCharges }: {
  a: Appt; ctx: DeskContext; busy: boolean;
  onVerb: (verb: DeskVerb) => void; onCheckout: () => void; onLink: () => void;
  /** Rev 2.3: the Charges window, to the LEFT of "Check out…" — for a visit linked to a patient record. */
  onCharges?: () => void;
}) {
  return (
    <>
      {deskActions(a, ctx).map((x) => {
        if (x.kind === 'link') return <button key="link" className="btn small" onClick={onLink}>{x.label}</button>;
        if (x.kind === 'check-out') {
          return (
            <span key="out" className="btn-pair">
              {onCharges && a.patient.id && <button className="btn small" disabled={busy} onClick={onCharges}>Charges</button>}
              <button className={`btn small${x.primary ? ' primary' : ''}`} disabled={busy} onClick={onCheckout}>{x.label}</button>
            </span>
          );
        }
        return (
          <button key={x.verb} className={`btn small${x.primary ? ' primary' : ''}`} disabled={busy || x.disabled} title={x.why} onClick={() => onVerb(x.verb)}>{x.label}</button>
        );
      })}
    </>
  );
}
