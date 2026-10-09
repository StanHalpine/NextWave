import { Link } from 'react-router-dom';
import { MODULES } from '../modules';

/** A module that exists as a navigation entry point but is built in a later phase. */
export default function ModulePlaceholder({ moduleKey, planned, legacy }: {
  moduleKey: string;
  /** What this module will contain — shown so the placeholder is not a dead end. */
  planned: string[];
  legacy?: { href: string; label: string };
}) {
  const m = MODULES.find((x) => x.key === moduleKey)!;
  return (
    <div className="card">
      <span className="tag">Phase {m.phase}</span>
      <h1>{m.label}</h1>
      <p className="lede">{m.blurb}</p>
      <p>This module is planned for <strong>Phase {m.phase}</strong> and is not built yet. It will contain:</p>
      <ul>{planned.map((p) => <li key={p}>{p}</li>)}</ul>
      {legacy && <p>In the meantime: <a href={legacy.href}>{legacy.label} →</a></p>}
      <Link className="btn" to="/">Back</Link>
    </div>
  );
}
