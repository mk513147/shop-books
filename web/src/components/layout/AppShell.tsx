import { NavLink, Outlet } from 'react-router-dom';
import { NAV_ITEMS } from '@/app/navigation';
import { cn } from '@/lib/utils';

/**
 * Responsive application frame: sidebar on md+ screens, bottom tab bar on phones.
 * Stage 1 placeholder; Stage 2 adds the signed-in user menu and sign-out.
 */
export function AppShell() {
  return (
    <div className="min-h-screen md:grid md:grid-cols-[14rem_1fr]">
      <aside className="hidden border-r bg-card md:flex md:flex-col">
        <div className="px-5 py-4 text-lg font-semibold text-primary">Shop-Books</div>
        <nav aria-label="Main" className="flex flex-col gap-1 px-3">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium hover:bg-accent',
                  isActive && 'bg-accent text-accent-foreground',
                )
              }
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-col pb-16 md:pb-0">
        <header className="border-b bg-card px-4 py-3 md:hidden">
          <span className="text-lg font-semibold text-primary">Shop-Books</span>
        </header>
        <main className="flex-1 p-4 md:p-8">
          <Outlet />
        </main>
      </div>

      <nav
        aria-label="Main (mobile)"
        className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-5 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-muted-foreground',
                isActive && 'text-primary',
              )
            }
          >
            <Icon className="size-5" aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
