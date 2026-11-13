import { fmtTime12 } from '../lib';

/**
 * The Schedule's hour gutter (Day and Week views).
 *
 * Its width comes from its content, not a pixel constant: the grid column is `max-content`, and an invisible in-flow
 * copy of the widest label (`.hour-sizer`, same font and padding as a label) gives the gutter its width. A fixed 58px
 * was narrower than "12:00 PM" at 11px mono, so the right-aligned labels overflowed to the left and the scroll box
 * clipped their first digit ("10:00 AM" read as "0:00 AM").
 */

/** Whole hours from opening to closing, in minutes after midnight. */
export const hourMarks = (openMin: number, closeMin: number): number[] =>
  Array.from({ length: Math.floor((closeMin - openMin) / 60) + 1 }, (_, i) => openMin + i * 60);

/** "7:00 AM" … "12:00 PM" … "7:00 PM". */
export const hourLabel = (minutes: number): string => fmtTime12(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:00`);

/**
 * The widest label any day can show. The labels are monospace, so the longest string is the widest; it is fixed (not
 * taken from the day's own hours) so the grid does not change width from one day to the next.
 */
export const WIDEST_HOUR_LABEL = hourLabel(12 * 60);   // "12:00 PM"

/** The grid-template-columns entry for the gutter. */
export const GUTTER_COLUMN = 'max-content';

export function HourGutter({ openMin, closeMin, pxPerMin }: { openMin: number; closeMin: number; pxPerMin: number }) {
  return (
    <div className="cal-gutter" style={{ height: (closeMin - openMin) * pxPerMin }}>
      {hourMarks(openMin, closeMin).map((m) => (
        <span key={m} className="hour-label" style={{ top: (m - openMin) * pxPerMin }}>{hourLabel(m)}</span>
      ))}
      {/* last, so `.hour-label:first-child` still finds the opening hour */}
      <span className="hour-sizer" aria-hidden="true">{WIDEST_HOUR_LABEL}</span>
    </div>
  );
}
