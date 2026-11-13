import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import css from '../styles.css?raw';
import { GUTTER_COLUMN, HourGutter, WIDEST_HOUR_LABEL, hourLabel, hourMarks } from './hourGutter';

/**
 * The Schedule's hour gutter clipped the first digit of two-digit hours ("10:00 AM" read "0:00 AM"): a fixed 58px column
 * was narrower than "12:00 PM" at 11px mono. There is no layout engine here, so the width is checked by construction —
 * the column is max-content, sized by an in-flow copy of the widest label in the label's own font — and in the browser.
 */

const render = (openMin: number, closeMin: number) =>
  renderToStaticMarkup(createElement(HourGutter, { openMin, closeMin, pxPerMin: 1.3 }));
const labelsIn = (html: string) => [...html.matchAll(/<span class="hour-label"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
/** The declarations of every rule whose selector list names `selector`. */
const rulesFor = (selector: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, sel]) => sel!.split(',').some((s) => s.trim() === selector))
    .map(([, , body]) => body!);

describe('Schedule hour gutter', () => {
  it('renders every hour 7 AM – 7 PM complete, first digit included', () => {
    const labels = labelsIn(render(7 * 60, 19 * 60));
    expect(labels).toEqual([
      '7:00 AM', '8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM',
      '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM',
    ]);
  });

  it('places each label at its hour', () => {
    const tops = [...render(7 * 60, 19 * 60).matchAll(/class="hour-label" style="top:([\d.]+)(?:px)?"/g)].map((m) => Number(m[1]));
    expect(tops).toEqual(hourMarks(7 * 60, 19 * 60).map((m) => +((m - 7 * 60) * 1.3).toFixed(10)));
  });

  it('sizes the gutter from the widest label any hour can show: "12:00 PM"', () => {
    expect(WIDEST_HOUR_LABEL).toBe('12:00 PM');
    const every = Array.from({ length: 24 }, (_, h) => hourLabel(h * 60));
    for (const l of every) expect(l.length, l).toBeLessThanOrEqual(WIDEST_HOUR_LABEL.length);
    // the sizer is in the gutter, holds that label, and is hidden from screen readers
    expect(render(7 * 60, 19 * 60)).toContain('<span class="hour-sizer" aria-hidden="true">12:00 PM</span>');
    // and stays last, so `.hour-label:first-child` is still the opening hour
    expect(render(9 * 60, 17 * 60)).toMatch(/^<div class="cal-gutter"[^>]*><span class="hour-label"[^>]*>9:00 AM<\/span>/);
  });

  it('the column is content-sized, and the sizer uses the label\'s font and spans its padding and offset', () => {
    expect(GUTTER_COLUMN).toBe('max-content');
    const shared = rulesFor('.hour-sizer').join(';');
    expect(rulesFor('.hour-label').join(';')).toContain('font: 500 11px var(--mono)');
    expect(shared).toContain('font: 500 11px var(--mono)');
    expect(shared).toContain('white-space: nowrap');
    // label: right offset 8px + 2px padding each side → sizer: 2 + 8 on the right, 2 + 6 on the left
    expect(rulesFor('.hour-label').join(';')).toMatch(/right: 8px;.*padding: 0 2px/);
    expect(shared).toContain('padding: 0 10px 0 8px');
  });

  it('nothing in the gutter clips or ellipsizes its text', () => {
    expect(css.length).toBeGreaterThan(1000);                                        // the stylesheet really was read
    for (const sel of ['.cal-gutter', '.hour-label', '.hour-sizer']) {
      const body = rulesFor(sel).join(';');
      expect(body, sel).not.toMatch(/overflow|text-overflow|clip/);
    }
  });
});
