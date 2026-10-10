import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { MODULES } from '../modules';

export default function Home() {
  const { me, hasRole } = useAuth();
  const visible = MODULES.filter((m) => hasRole(...m.roles));
  return (
    <>
      <h1>Welcome, {me?.account.displayName.split(' ')[0]}</h1>
      <p className="lede">Choose a module.</p>
      <div className="grid">
        {visible.map((m) => {
          const body = (
            <>
              <h2>{m.label}</h2>
              <p>{m.blurb}</p>
              {!m.built && <span className="tag">Coming in Phase {m.phase}</span>}
            </>
          );
          return m.href
            ? <a key={m.key} className="tile" href={m.href}>{body}</a>
            : <Link key={m.key} className="tile" to={m.to!}>{body}</Link>;
        })}
        {hasRole('ADMIN') && (
          <Link className="tile" to="/admin"><h2>Admin</h2><p>Accounts, audit log, and system configuration.</p></Link>
        )}
      </div>
    </>
  );
}
