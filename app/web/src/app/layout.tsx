import { NavLink, Outlet } from 'react-router-dom';
import { useHealth } from '../api/v2.js';
import { RouteErrorBoundary } from '../components/RouteErrorBoundary.js';
import { useTheme } from './theme.js';
import { ToastContainer } from './toast.js';

const navItems = [
  { to: '/', label: 'Status', end: true },
  { to: '/sites', label: 'Sites' },
  { to: '/files', label: 'Files' },
  { to: '/policies', label: 'Policies' },
  { to: '/lab', label: 'Lab' },
  { to: '/activity', label: 'Activity' },
  { to: '/archived', label: 'Archived' },
  { to: '/settings', label: 'Settings' },
];

export function AppLayout() {
  const { theme, toggleTheme } = useTheme();
  const { data: health } = useHealth();
  const commit = health?.build?.commit?.slice(0, 7) ?? null;

  return (
    <div className="flex min-h-full">
      <aside className="hidden w-56 shrink-0 border-r border-border bg-card lg:flex lg:flex-col">
        <div className="border-b border-border px-4 py-5">
          <div className="text-lg font-semibold text-ink">SpoStorage</div>
          <div className="text-xs text-muted">SharePoint audit</div>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm ${
                  isActive ? 'bg-accent/10 font-medium text-accent' : 'text-muted hover:bg-bg hover:text-ink'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-3">
          <div className="flex items-center gap-3 lg:hidden">
            <select
              className="rounded-lg border border-border bg-card px-2 py-1 text-sm"
              defaultValue=""
              onChange={(event) => {
                if (event.target.value) window.location.href = event.target.value;
              }}
            >
              <option value="" disabled>
                Navigation
              </option>
              {navItems.map((item) => (
                <option key={item.to} value={item.to}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          <div className="relative flex flex-1 items-center justify-end gap-3">
            {commit ? (
              <span className="font-mono text-xs text-muted" title="Deployed commit">
                {commit}
              </span>
            ) : null}
            <button
              type="button"
              onClick={toggleTheme}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-bg"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-x-hidden p-4 lg:p-6">
          <RouteErrorBoundary>
            <Outlet />
          </RouteErrorBoundary>
        </main>
      </div>

      <ToastContainer />
    </div>
  );
}
