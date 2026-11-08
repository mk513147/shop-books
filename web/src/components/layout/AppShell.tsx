import { BookMarked, KeyRound, LogOut, Menu, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { navItemsFor, type NavItem } from '@/app/navigation';
import { Dialog } from '@/components/ui/dialog';
import { useAuth } from '@/features/auth/auth-context';
import { useLiveUpdates } from '@/features/sync/useLiveUpdates';
import { cn } from '@/lib/utils';

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="inline-flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <BookMarked className="size-4.5" aria-hidden="true" />
      </span>
      <span className="text-base font-semibold tracking-tight">Shop-Books</span>
    </Link>
  );
}

function useSignOut() {
  const { logout } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  return {
    signingOut,
    signOut: () => {
      setSigningOut(true);
      void logout().finally(() => setSigningOut(false));
    },
  };
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
    isActive && 'bg-primary-soft text-primary-soft-foreground hover:bg-primary-soft hover:text-primary-soft-foreground',
  );

function SidebarLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink to={item.to} end={item.to === '/'} className={navLinkClass}>
      <Icon className="size-4.5" aria-hidden="true" />
      {item.label}
    </NavLink>
  );
}

function UserBlock({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth();
  const { signingOut, signOut } = useSignOut();
  if (!user) return null;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold uppercase">
          {user.name.slice(0, 1)}
        </span>
        <div className="min-w-0 text-sm">
          <p className="truncate font-medium">{user.name}</p>
          <p className="text-xs capitalize text-muted-foreground">{user.role}</p>
        </div>
      </div>
      <NavLink to="/change-password" className={navLinkClass} onClick={onNavigate}>
        <KeyRound className="size-4.5" aria-hidden="true" />
        Change password
      </NavLink>
      <button type="button" className={cn(navLinkClass({ isActive: false }), 'w-full')} disabled={signingOut} onClick={signOut}>
        <LogOut className="size-4.5" aria-hidden="true" />
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}

/** Phone bottom bar: main tabs, a central "Add expense" action and "More" for everything else. */
function BottomNav({ items }: { items: NavItem[] }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();
  const tabs = items.filter((i) => i.mobileTab);
  const more = items.filter((i) => !i.mobileTab);
  const moreActive = more.some((i) => location.pathname.startsWith(i.to)) || location.pathname === '/change-password';

  const tab = (item: NavItem) => {
    const Icon = item.icon;
    return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.to === '/'}
        className={({ isActive }) =>
          cn(
            'flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground',
            isActive && 'text-primary',
          )
        }
      >
        <Icon className="size-5" aria-hidden="true" />
        {item.mobileLabel ?? item.label}
      </NavLink>
    );
  };

  return (
    <>
      <nav
        aria-label="Main (mobile)"
        className="fixed inset-x-0 bottom-0 z-20 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] shadow-raised backdrop-blur md:hidden"
      >
        <div className="mx-auto flex h-(--bottom-nav-height) max-w-lg items-stretch px-1">
          {tabs.slice(0, 2).map(tab)}
          <div className="flex flex-1 items-center justify-center">
            <Link
              to="/expenses/new"
              aria-label="Add expense"
              className="inline-flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <Plus className="size-6" aria-hidden="true" />
            </Link>
          </div>
          {tabs.slice(2).map(tab)}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground',
              moreActive && 'text-primary',
            )}
          >
            <Menu className="size-5" aria-hidden="true" />
            More
          </button>
        </div>
      </nav>
      <Dialog open={moreOpen} title="More" onClose={() => setMoreOpen(false)} size="sm">
        <nav aria-label="More" className="space-y-1">
          {more.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} className={navLinkClass} onClick={() => setMoreOpen(false)}>
                <Icon className="size-4.5" aria-hidden="true" />
                {item.label}
                {item.placeholder && <span className="ml-auto text-xs font-normal text-muted-foreground">Coming later</span>}
              </NavLink>
            );
          })}
        </nav>
        <div className="mt-3 border-t pt-3">
          <UserBlock onNavigate={() => setMoreOpen(false)} />
        </div>
      </Dialog>
    </>
  );
}

/** Responsive application frame: sidebar on md+ screens, top bar + bottom navigation on phones. */
export function AppShell() {
  const { user } = useAuth();
  const items = navItemsFor(user?.role);
  // Changes made on other phones refresh this one, with a small notification (Features 1 and 3).
  useLiveUpdates();

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r bg-card md:flex">
        <div className="px-5 py-5">
          <Brand />
        </div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1 overflow-y-auto px-3">
          {items.map((item) => (
            <SidebarLink key={item.to} item={item} />
          ))}
        </nav>
        <div className="border-t p-3">
          <UserBlock />
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-10 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-center border-b bg-card/95 px-4 pt-[env(safe-area-inset-top)] backdrop-blur md:hidden">
          <Brand />
        </header>
        <main className="pb-bottom-nav flex-1 px-4 pt-4 md:px-8 md:pb-10 md:pt-8">
          <Outlet />
        </main>
      </div>

      <BottomNav items={items} />
    </div>
  );
}
