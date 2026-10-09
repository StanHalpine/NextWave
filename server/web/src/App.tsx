import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth';
import { Protected, StepGate } from './components';
import Login from './pages/Login';
import Setup from './pages/Setup';
import ChangePassword from './pages/ChangePassword';
import { MfaEnroll, MfaVerify } from './pages/Mfa';
import Home from './pages/Home';
import ModulePlaceholder from './pages/ModulePlaceholder';
import AdminHome from './pages/AdminHome';
import AdminAccounts from './pages/AdminAccounts';
import AuditLog from './pages/AuditLog';

/** Brand header for the pages shown before sign-in completes (no module nav yet). */
function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth-brand">NextWave <span>Staff</span></div>
      {children}
    </div>
  );
}

/** /schedule has no page of its own yet — it is the existing grid. */
function ToLegacySchedule() {
  window.location.replace('/dashboard.html');
  return null;
}

export default function App() {
  return (
    <BrowserRouter basename="/app">
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<AuthFrame><Login /></AuthFrame>} />
          <Route path="/setup" element={<AuthFrame><Setup /></AuthFrame>} />
          <Route path="/change-password" element={<StepGate need="change_password"><AuthFrame><ChangePassword /></AuthFrame></StepGate>} />
          <Route path="/mfa/enroll" element={<StepGate need="mfa_enroll"><AuthFrame><MfaEnroll /></AuthFrame></StepGate>} />
          <Route path="/mfa/verify" element={<StepGate need="mfa_verify"><AuthFrame><MfaVerify /></AuthFrame></StepGate>} />

          <Route path="/" element={<Protected><Home /></Protected>} />
          <Route path="/front-desk" element={<Protected roles={['FRONT_DESK', 'ADMIN']}>
            <ModulePlaceholder moduleKey="front-desk" legacy={{ href: '/dashboard.html', label: 'Open the current front desk grid' }}
              planned={["Today's appointments, checked-in patients, and patients seen / checked out", 'Check-in, check-out and no-show', 'Patient directory and profiles, with the credit tracker']} />
          </Protected>} />
          <Route path="/schedule" element={<Protected roles={['FRONT_DESK', 'ADMIN']}><ToLegacySchedule /></Protected>} />
          <Route path="/provider" element={<Protected roles={['PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE', 'ADMIN']}>
            <ModulePlaceholder moduleKey="provider" planned={['Your checked-in patients, filtered by specialty', 'SOAP note workspace with your own macro sets', 'AI scribe recording, reviewed and signed by you']} />
          </Protected>} />
          <Route path="/accounting" element={<Protected roles={['ADMIN']}>
            <ModulePlaceholder moduleKey="accounting" planned={['Monthly revenue by service', 'Daily revenue breakdown', 'Member vs. non-member revenue', 'Custom financial analytics']} />
          </Protected>} />
          <Route path="/reports" element={<Protected roles={['FRONT_DESK', 'ADMIN']}>
            <ModulePlaceholder moduleKey="reports" planned={['New membership sign-ups per month', 'Walk-in volume', 'Weekend visit metrics', 'Service demand: chiropractic, HBOT, red light, IV, consults, bloodwork']} />
          </Protected>} />

          <Route path="/admin" element={<Protected roles={['ADMIN']}><AdminHome /></Protected>} />
          <Route path="/admin/accounts" element={<Protected roles={['ADMIN']}><AdminAccounts /></Protected>} />
          <Route path="/admin/audit" element={<Protected roles={['ADMIN']}><AuditLog /></Protected>} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
