import { deskActions, type DeskContext, type DeskVerb } from '../frontdesk';
import type { Appt } from '../types';

/** The front-desk buttons for one appointment (see frontdesk.ts for which, and why). Shared by the card and the dialog. */
export function DeskActions({ a, ctx, busy, onVerb, onCheckout, onLink }: {
  a: Appt; ctx: DeskContext; busy: boolean;
  onVerb: (verb: DeskVerb) => void; onCheckout: () => void; onLink: () => void;
}) {
  return (
    <>
      {deskActions(a, ctx).map((x) => {
        if (x.kind === 'link') return <button key="link" className="btn small" onClick={onLink}>{x.label}</button>;
        if (x.kind === 'check-out') return <button key="out" className={`btn small${x.primary ? ' primary' : ''}`} disabled={busy} onClick={onCheckout}>{x.label}</button>;
        return (
          <button key={x.verb} className={`btn small${x.primary ? ' primary' : ''}`} disabled={busy || x.disabled} title={x.why} onClick={() => onVerb(x.verb)}>{x.label}</button>
        );
      })}
    </>
  );
}
