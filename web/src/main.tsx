import { StrictMode, createContext, useContext, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { api, setCsrf, type Me } from './api';
import { CallbacksPage } from './pages/Callbacks';
import { CarrierAccountsPage } from './pages/CarrierAccounts';
import { DashboardPage } from './pages/Dashboard';
import { LoginPage } from './pages/Login';
import { NewShipmentPage, StoreSelectedPage } from './pages/NewShipment';
import { OutboxPage } from './pages/Outbox';
import { ShipmentDetailPage } from './pages/ShipmentDetail';
import { ShipmentsPage } from './pages/Shipments';
import { TenantsPage } from './pages/Tenants';
import './styles.css';

const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext);

function RequireLogin() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const loc = useLocation();
  useEffect(() => {
    api<Me>('/auth/me')
      .then((m) => {
        setCsrf(m.csrf_token);
        setMe(m);
      })
      .catch(() => setMe(null));
  }, []);
  if (me === undefined) return <div className="login-wrap muted">載入中…</div>;
  if (me === null) return <Navigate to={`/login?return_to=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return (
    <MeContext.Provider value={me}>
      <Layout me={me} />
    </MeContext.Provider>
  );
}

function Layout({ me }: { me: Me }) {
  const logout = async (global: boolean) => {
    const r = await api<{ end_session_url: string | null }>('/auth/logout', { method: 'POST', json: { global } });
    window.location.href = r.end_session_url ?? '/login';
  };
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">⬡</span> 物流管理平台
        </div>
        <nav className="nav">
          <NavLink to="/" end>總覽</NavLink>
          <NavLink to="/shipments">託運單</NavLink>
          <NavLink to="/shipments/new">建立測試單</NavLink>
          <NavLink to="/outbox">Webhook 事件</NavLink>
          <NavLink to="/carrier-callbacks">物流商回調</NavLink>
          <NavLink to="/tenants">租戶與 API Key</NavLink>
          <NavLink to="/carrier-accounts">物流商帳號</NavLink>
        </nav>
        <div className="sidebar-foot">
          <div>{me.name ?? me.email ?? me.sub}</div>
          {me.email && me.name && <div>{me.email}</div>}
          {me.dev_bypass && <div className="badge warn">開發登入</div>}
          <div className="row">
            <button className="small" onClick={() => logout(false)}>登出</button>
            {!me.dev_bypass && (
              <button className="small" onClick={() => logout(true)} title="同時登出 auth-service">
                全站登出
              </button>
            )}
          </div>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireLogin />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/shipments" element={<ShipmentsPage />} />
          <Route path="/shipments/new" element={<NewShipmentPage />} />
          <Route path="/shipments/:id" element={<ShipmentDetailPage />} />
          <Route path="/store-selected" element={<StoreSelectedPage />} />
          <Route path="/outbox" element={<OutboxPage />} />
          <Route path="/carrier-callbacks" element={<CallbacksPage />} />
          <Route path="/tenants" element={<TenantsPage />} />
          <Route path="/carrier-accounts" element={<CarrierAccountsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
