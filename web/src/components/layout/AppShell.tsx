import { KeyRound, LogOut } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { navItemsFor } from '@/app/navigation';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/auth-context';
import { cn } from '@/lib/utils';

function UserMenu({ compact = false }: { compact?: boolean }) {
  const { user, logout } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  if (!user) return null;
  return (
    <div className={cn('flex items-center gap-2', !compact && 'flex-col items-stretch')}>
      {!compact && (
        <div className="px-3 text-sm">
          <p className="truncate font-medium">{user.name}</p>
          <p className="text-xs capitalize text-muted-foreground">{user.role}</p>
        </div>
      )}
      <Link
        to="/change-password"
        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
        aria-label="Change password"
      >
        <KeyRound className="size-4" aria-hidden="true" />
        {!compact && 'Change password'}
      </Link>
      <Button
        variant="ghost"
        size="sm"
        className={cn(!compact && 'justify-start')}
        disabled={signingOut}
        onClick={() => {
          setSigningOut(true);
          void logout().finally(() => setSigningOut(false));
        }}
      >
        <LogOut className="size-4" aria-hidden="true" />
        {compact ? <span className="sr-only">Sign out</span> : 'Sign out'}
      </Button>
    </div>
  );
}

/** Responsive application frame: sidebar on md+ screens, bottom tab bar on phones. */
export function AppShell() {
  const { user } = useAuth();
  const items = navItemsFor(user?.role);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[14rem_1fr]">
      <aside className="hidden border-r bg-card md:flex md:flex-col">
        <div className="px-5 py-4 text-lg font-semibold text-primary">Shop-Books</div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1 px-3">
          {items.map(({ to, label, icon: Icon }) => (
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
        <div className="border-t p-3">
          <UserMenu />
        </div>
      </aside>

      <div className="flex min-w-0 flex-col pb-16 md:pb-0">
        <header className="flex items-center justify-between border-b bg-card px-4 py-2 md:hidden">
          <span className="text-lg font-semibold text-primary">Shop-Books</span>
          <UserMenu compact />
        </header>
        <main className="flex-1 p-4 md:p-8">
          <Outlet />
        </main>
      </div>

      <nav
        aria-label="Main (mobile)"
        className="fixed inset-x-0 bottom-0 z-10 flex border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-muted-foreground',
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
