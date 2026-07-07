import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAppStore } from '../lib/store';
import { getConnections } from '../lib/api';
import styles from './Shell.module.css';

const NAV = [
  { section: 'Schema' },
  { to: '/forms',  label: 'Forms & Fields', icon: '▦' },
  { to: '/menus',  label: 'Menus',          icon: '≡' },
  { section: 'Compare' },
  { to: '/compare', label: 'Compare', icon: '⇄' },
  { section: 'Config' },
  { to: '/connections', label: 'Connections', icon: '⬡' },
  { to: '/diagnostic',  label: 'Diagnostics', icon: '⚕' },
];

export default function Shell() {
  const { activeConnectionId, setActiveConnection } = useAppStore();
  const navigate = useNavigate();

  const { data: connections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: getConnections
  });

  const activeConn = connections.find(c => c.id === activeConnectionId);

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandIcon}>◈</span>
          <div>
            <div className={styles.brandName}>Helix Dev Tool</div>
            <div className={styles.brandSub}>AR System Studio</div>
          </div>
        </div>

        <div className={styles.connSelector}>
          <div className={styles.connLabel}>Instance</div>
          <select
            className={styles.connSelect}
            value={activeConnectionId || ''}
            onChange={e => {
              setActiveConnection(e.target.value || null);
              if (!e.target.value) navigate('/connections');
            }}
          >
            <option value="">— select —</option>
            {connections.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {activeConn && (
            <div className={styles.connUrl}>{activeConn.baseUrl}</div>
          )}
        </div>

        <nav className={styles.nav}>
          {NAV.map((item, i) => {
            if (item.section) {
              return <div key={i} className={styles.navSection}>{item.section}</div>;
            }
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `${styles.navItem} ${isActive ? styles.active : ''}`
                }
              >
                <span className={styles.navIcon}>{item.icon}</span>
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className={styles.sidebarFooter}>
          <span className={styles.version}>v1.0.0 · Helix 25+</span>
        </div>
      </aside>

      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
