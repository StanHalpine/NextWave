import { describe, expect, it } from 'vitest';
import { idlePhase, secondsUntilSignOut, shouldPing, SIGN_OUT_AFTER_MS, WARN_AFTER_MS } from './idle';

const T = 1_000_000;
describe('idle policy', () => {
  it('is active up to the 14-minute mark', () => {
    expect(idlePhase(T + WARN_AFTER_MS - 1, T)).toBe('active');
  });
  it('warns from 14 minutes', () => {
    expect(idlePhase(T + WARN_AFTER_MS, T)).toBe('warning');
    expect(idlePhase(T + SIGN_OUT_AFTER_MS - 1, T)).toBe('warning');
  });
  it('expires at 15 minutes', () => {
    expect(idlePhase(T + SIGN_OUT_AFTER_MS, T)).toBe('expired');
  });
  it('counts down the final minute', () => {
    expect(secondsUntilSignOut(T + WARN_AFTER_MS, T)).toBe(60);
    expect(secondsUntilSignOut(T + WARN_AFTER_MS + 30_000, T)).toBe(30);
    expect(secondsUntilSignOut(T + SIGN_OUT_AFTER_MS + 5000, T)).toBe(0);
  });
  it('pings only when a person was active since the last ping, and not more than once a minute', () => {
    expect(shouldPing(T + 120_000, T, T + 119_000)).toBe(false); // no input since last ping
    expect(shouldPing(T + 30_000, T + 20_000, T)).toBe(false);   // too soon
    expect(shouldPing(T + 90_000, T + 80_000, T)).toBe(true);
  });
});
