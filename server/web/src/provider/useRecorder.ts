import { useCallback, useEffect, useRef, useState } from 'react';
import { pickAudioType } from './docs';

export type RecorderState = 'idle' | 'starting' | 'recording' | 'error';
/** A visit longer than this is stopped for the provider, so a forgotten recording cannot run all day. */
export const MAX_RECORDING_SECONDS = 90 * 60;

/**
 * Records the microphone in the browser. Nothing leaves the page here: the audio is held as chunks in
 * memory until the caller uploads the finished Blob (to the URL the server hands out), and the
 * microphone is released the moment recording stops or the component goes away.
 */
export function useRecorder(onLimit?: () => void) {
  const [state, setState] = useState<RecorderState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const tick = useRef<number | null>(null);
  const began = useRef(0);
  const limit = useRef(onLimit);
  limit.current = onLimit;

  const release = useCallback(() => {
    if (tick.current != null) window.clearInterval(tick.current);
    tick.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  useEffect(() => () => { try { recorder.current?.stop(); } catch { /* already stopped */ } release(); }, [release]);

  /** Start recording. Resolves to the audio format being produced, or null (with `error` set) if it could not start. */
  const start = useCallback(async (): Promise<string | null> => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState('error'); setError('This browser cannot record audio. You can still write the note yourself.');
      return null;
    }
    setState('starting');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = s;
      const type = pickAudioType((t) => MediaRecorder.isTypeSupported(t));
      const r = new MediaRecorder(s, type ? { mimeType: type } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
      r.start(1000);                                    // a chunk a second, so a crash loses little
      recorder.current = r;
      began.current = Date.now();
      setSeconds(0);
      tick.current = window.setInterval(() => {
        const sec = (Date.now() - began.current) / 1000;
        setSeconds(sec);
        if (sec >= MAX_RECORDING_SECONDS) limit.current?.();
      }, 500);
      setState('recording');
      return r.mimeType || type || 'audio/webm';
    } catch (e) {
      release();
      setState('error');
      setError(e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
        ? 'The microphone is blocked. Allow it in the browser’s address bar and try again.'
        : e instanceof DOMException && e.name === 'NotFoundError' ? 'No microphone was found.' : 'The microphone could not be started.');
      return null;
    }
  }, [release]);

  /** Stop and hand back what was recorded. */
  const stop = useCallback((): Promise<{ blob: Blob; type: string }> => new Promise((resolve, reject) => {
    const r = recorder.current;
    if (!r || r.state === 'inactive') { reject(new Error('Nothing is being recorded.')); return; }
    r.onstop = () => {
      const type = r.mimeType || 'audio/webm';
      const blob = new Blob(chunks.current, { type });
      chunks.current = [];
      release();
      recorder.current = null;
      setState('idle');
      resolve({ blob, type });
    };
    r.stop();
  }), [release]);

  /** Stop and throw the audio away. */
  const cancel = useCallback(() => {
    const r = recorder.current;
    if (r && r.state !== 'inactive') { r.onstop = null; try { r.stop(); } catch { /* already stopped */ } }
    chunks.current = [];
    recorder.current = null;
    release();
    setState('idle');
    setSeconds(0);
  }, [release]);

  return { state, seconds, error, start, stop, cancel };
}
