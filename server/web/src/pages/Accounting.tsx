import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { AccountingOptions } from '../types';
import ReportPanel from '../reports/ReportPanel';

const VIEWS = [
  { key: 'monthly', label: 'Monthly by service' },
  { key: 'daily', label: 'Daily' },
  { key: 'members', label: 'Members vs. non-members' },
  { key: 'custom', label: 'Custom' },
];
const GROUP_LABEL: Record<string, string> = {
  service: 'Service', month: 'Month', day: 'Day', serviceMonth: 'Month and service', paymentType: 'Payment type', bucket: 'Who paid, and how',
  provider: 'Provider', category: 'Discipline', discountCategory: 'Discount category', tier: 'Membership tier',
};

/** Accounting (administrators only): revenue from the check-out records, as totals — never as visits or people. */
export default function Accounting() {
  const [view, setView] = useState('monthly');
  const [options, setOptions] = useState<AccountingOptions | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [paymentType, setPaymentType] = useState('');
  const [providerId, setProviderId] = useState('');
  const [group, setGroup] = useState('service');
  useEffect(() => { api<AccountingOptions>('/api/accounting/options').then(setOptions).catch(() => setOptions(null)); }, []);

  return (
    <>
      <p><Link to="/">← Modules</Link></p>
      <h1>Accounting</h1>
      <p className="lede">Revenue as the front desk recorded it at check-out. Every figure is a total: no patient, appointment or visit is named, and an export carries the same.</p>
      <div className="tabs" role="tablist">
        {VIEWS.map((v) => <button key={v.key} role="tab" aria-selected={view === v.key} className={view === v.key ? 'on' : ''} onClick={() => setView(v.key)}>{v.label}</button>)}
      </div>

      {view === 'custom' && (
        <div className="filters">
          <label>Service<select value={serviceId} onChange={(e) => setServiceId(e.target.value)}><option value="">All services</option>{options?.services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Payment<select value={paymentType} onChange={(e) => setPaymentType(e.target.value)}><option value="">Any</option>{options?.paymentTypes.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
          <label>Provider<select value={providerId} onChange={(e) => setProviderId(e.target.value)}><option value="">All providers</option>{options?.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>Total by<select value={group} onChange={(e) => setGroup(e.target.value)}>{(options?.groups ?? Object.keys(GROUP_LABEL)).map((g) => <option key={g} value={g}>{GROUP_LABEL[g] ?? g}</option>)}</select></label>
        </div>
      )}

      <ReportPanel endpoint="/api/accounting" view={view} extra={view === 'custom' ? { serviceId, paymentType, providerId, group } : {}} />
    </>
  );
}
