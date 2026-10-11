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
import AdminMemberships from './pages/AdminMemberships';
import AdminMacros from './pages/AdminMacros';
import Provider from './pages/Provider';
import Documentation from './pages/Documentation';
import FrontDesk from './pages/FrontDesk';
import Patients from './pages/Patients';
import PatientProfile from './pages/PatientProfile';
import Schedule from './pages/Schedule';
import Accounting from './pages/Accounting';
import Reports from './pages/Reports';

/** Brand header for the pages shown before sign-in completes (no module nav yet). */
function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth-brand">NextWave <span>Staff</span></div>
      {children}
    </div>
  );
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
          <Route path="/front-desk" element={<Protected roles={['FRONT_DESK', 'ADMIN']}><FrontDesk /></Protected>} />
          <Route path="/front-desk/patients" element={<Protected roles={['FRONT_DESK', 'ADMIN']}><Patients /></Protected>} />
          <Route path="/front-desk/patients/:id" element={<Protected roles={['FRONT_DESK', 'ADMIN']}><PatientProfile /></Protected>} />
          <Route path="/schedule" element={<Protected roles={['FRONT_DESK', 'ADMIN']}><Schedule /></Protected>} />
          <Route path="/provider" element={<Protected roles={['PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE', 'ADMIN']}><Provider /></Protected>} />
          <Route path="/provider/visits/:id" element={<Protected roles={['PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE', 'ADMIN']}><Documentation /></Protected>} />
          <Route path="/accounting" element={<Protected roles={['ADMIN']}><Accounting /></Protected>} />
          <Route path="/reports" element={<Protected roles={['FRONT_DESK', 'ADMIN']}><Reports /></Protected>} />

          <Route path="/admin" element={<Protected roles={['ADMIN']}><AdminHome /></Protected>} />
          <Route path="/admin/accounts" element={<Protected roles={['ADMIN']}><AdminAccounts /></Protected>} />
          <Route path="/admin/membership" element={<Protected roles={['ADMIN']}><AdminMemberships /></Protected>} />
          <Route path="/admin/macros" element={<Protected roles={['ADMIN']}><AdminMacros /></Protected>} />
          <Route path="/admin/audit" element={<Protected roles={['ADMIN']}><AuditLog /></Protected>} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
