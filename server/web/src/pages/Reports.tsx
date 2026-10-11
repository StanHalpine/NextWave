import { useState } from 'react';
import { Link } from 'react-router-dom';
import ReportPanel, { Stats } from '../reports/ReportPanel';

const VIEWS = [
  { key: 'signups', label: 'New memberships' },
  { key: 'walkins-day', label: 'Walk-ins by day' },
  { key: 'walkins-hour', label: 'Walk-ins by hour' },
  { key: 'weekend', label: 'Weekend visits' },
  { key: 'demand', label: 'Service demand' },
];

/** Reports (front desk and administrators): counts only. */
export default function Reports() {
  const [view, setView] = useState('signups');
  return (
    <>
      <p><Link to="/">← Modules</Link></p>
      <h1>Reports</h1>
      <p className="lede">How busy the clinic is: sign-ups, walk-ins, weekends and what people book. Counts only: no patient is named, and an export carries the same.</p>
      <div className="tabs" role="tablist">
        {VIEWS.map((v) => <button key={v.key} role="tab" aria-selected={view === v.key} className={view === v.key ? 'on' : ''} onClick={() => setView(v.key)}>{v.label}</button>)}
      </div>
      <ReportPanel endpoint="/api/reports" view={view}>
        {(d) => {
          const s = d.summary;
          if (!s) return null;
          if (view.startsWith('walkins')) {
            return <Stats items={[{ label: 'Walk-ins', value: String(s.walkIns) }, { label: 'All visits checked in', value: String(s.allVisits) }, { label: 'Walk-in share', value: `${s.sharePercent}%` }]} />;
          }
          if (view === 'weekend') {
            return <Stats items={[
              { label: 'Weekend visits', value: String(s.weekendVisits) }, { label: 'Weekday visits', value: String(s.weekdayVisits) },
              { label: 'Weekend share', value: `${s.weekendSharePercent}%` }, { label: 'Saturday', value: String(s.saturdayVisits) },
              { label: 'Sunday', value: String(s.sundayVisits) }, { label: 'Weekend no-shows', value: String(s.weekendNoShows) },
            ]} />;
          }
          return null;
        }}
      </ReportPanel>
    </>
  );
}
