import { BookMarked, ChevronRight, Keyboard, KeyRound, LogOut, Menu, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { NAV_GROUPS, navItemsFor, type NavItem } from '@/app/navigation';
import { Dialog } from '@/components/ui/dialog';
import { useAuth } from '@/features/auth/auth-context';
import { AttachmentQueueProvider, useAttachmentQueue } from '@/features/documents/queue/AttachmentQueueProvider';
import { AttachmentSyncBanner } from '@/features/documents/queue/LocalAttachments';
import { PausedDeviceFilesNotice } from '@/features/documents/queue/PausedDeviceFiles';
import { billAttachmentsEnabled } from '@/features/documents/attachments-feature';
import { ShortcutsProvider, useShortcuts } from '@/features/shortcuts/ShortcutsProvider';
import { useLiveUpdates } from '@/features/sync/useLiveUpdates';
import { cn } from '@/lib/utils';
import { useKeyboardOpen } from '@/lib/visual-viewport';

/** The Shop-Books mark: a ledger book on the jade accent. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-[0.625rem] bg-primary text-primary-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.18),0_1px_2px_oklch(0.3_0.06_170/0.3)]',
        className,
      )}
    >
      <BookMarked className="size-[1.1rem]" aria-hidden="true" />
    </span>
  );
}

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <BrandMark />
      <span className="text-[1.0625rem] font-semibold tracking-[-0.02em]">Shop-Books</span>
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase() || '?';
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'group relative flex h-9 items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    isActive && 'bg-primary-soft text-primary-soft-foreground hover:bg-primary-soft hover:text-primary-soft-foreground',
  );

function SidebarLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink to={item.to} end={item.to === '/'} className={navLinkClass}>
      {({ isActive }) => (
        <>
          {/* Active indicator rail. */}
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-y-2 -left-3 w-[3px] origin-center rounded-r-full bg-primary transition-transform duration-200 ease-out',
              isActive ? 'scale-y-100' : 'scale-y-0',
            )}
          />
          <Icon className={cn('size-[1.125rem] transition-colors', isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} aria-hidden="true" />
          {item.label}
        </>
      )}
    </NavLink>
  );
}

function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[0.8125rem] font-semibold text-primary-soft-foreground ring-1 ring-primary/15',
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

function UserBlock({ onNavigate, compact = false }: { onNavigate?: () => void; compact?: boolean }) {
  const { user } = useAuth();
  const { signingOut, signOut } = useSignOut();
  if (!user) return null;
  const actionClass = compact
    ? 'inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'
    : undefined;
  return (
    <div className="space-y-1">
      <div className={cn('flex items-center gap-3 rounded-lg', compact ? 'px-2 py-1.5' : 'px-3 py-2')}>
        <Avatar name={user.name} />
        <div className="min-w-0 text-sm">
          <p className="truncate font-semibold">{user.name}</p>
          <p className="text-xs capitalize text-muted-foreground">{user.role}</p>
        </div>
      </div>
      <div className={compact ? 'flex justify-between gap-1' : 'space-y-1'}>
        <NavLink to="/change-password" className={compact ? ({ isActive }) => cn(actionClass, isActive && 'bg-primary-soft text-primary-soft-foreground') : navLinkClass} onClick={onNavigate}>
          <KeyRound className={compact ? 'size-3.5' : 'size-[1.125rem]'} aria-hidden="true" />
          Change password
        </NavLink>
        <button type="button" className={compact ? actionClass : cn(navLinkClass({ isActive: false }), 'w-full')} disabled={signingOut} onClick={signOut}>
          <LogOut className={compact ? 'size-3.5' : 'size-[1.125rem]'} aria-hidden="true" />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </div>
  );
}

const tabClass = 'group flex flex-1 select-none flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium text-muted-foreground transition-colors focus-visible:outline-none';

/** Icon inside a pill that fills in when the tab is active (and shows the focus ring). */
function TabIcon({ icon: Icon, active }: { icon: NavItem['icon']; active: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-8 w-14 items-center justify-center rounded-full transition-[background-color,color,transform] duration-200 ease-out group-focus-visible:ring-2 group-focus-visible:ring-ring group-active:scale-90',
        active ? 'bg-primary-soft text-primary' : 'text-muted-foreground',
      )}
    >
      <Icon className="size-5" aria-hidden="true" />
    </span>
  );
}

/** Phone bottom bar: main tabs, a central "Add expense" action and "More" for everything else. */
function BottomNav({ items }: { items: NavItem[] }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();
  const keyboardOpen = useKeyboardOpen();
  const tabs = items.filter((i) => i.mobileTab);
  const more = items.filter((i) => !i.mobileTab);
  const moreActive = more.some((i) => location.pathname.startsWith(i.to)) || location.pathname === '/change-password';

  const tab = (item: NavItem) => (
    <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => cn(tabClass, isActive && 'font-semibold text-primary')}>
      {({ isActive }) => (
        <>
          <TabIcon icon={item.icon} active={isActive} />
          {item.mobileLabel ?? item.label}
        </>
      )}
    </NavLink>
  );

  return (
    <>
      <nav
        aria-label="Main (mobile)"
        data-keyboard={keyboardOpen ? 'open' : undefined}
        className="fixed inset-x-0 bottom-0 z-20 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] shadow-dock backdrop-blur-md data-[keyboard=open]:invisible md:hidden"
      >
        <div className="mx-auto flex h-(--bottom-nav-height) max-w-lg items-stretch px-1">
          {tabs.slice(0, 2).map(tab)}
          <Link to="/expenses/new" aria-label="Add expense" className={cn(tabClass, 'text-primary')}>
            <span className="inline-flex h-8 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_2px_6px_oklch(0.35_0.07_170/0.35)] transition-transform duration-150 group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-active:scale-90">
              <Plus className="size-5" strokeWidth={2.5} aria-hidden="true" />
            </span>
            <span aria-hidden="true" className="font-semibold">
              Add
            </span>
          </Link>
          {tabs.slice(2).map(tab)}
          <button type="button" onClick={() => setMoreOpen(true)} className={cn(tabClass, moreActive && 'font-semibold text-primary')}>
            <TabIcon icon={Menu} active={moreActive} />
            More
          </button>
        </div>
      </nav>
      <Dialog open={moreOpen} title="More" onClose={() => setMoreOpen(false)} size="sm">
        <nav aria-label="More" className="grid grid-cols-2 gap-2">
          {more.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMoreOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-[4.5rem] flex-col justify-between gap-2 rounded-xl border bg-card p-3 text-sm font-medium transition-[background-color,transform] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isActive ? 'border-primary/30 bg-primary-soft text-primary-soft-foreground' : 'hover:bg-surface-muted',
                  )
                }
              >
                <Icon className="size-5 text-primary" aria-hidden="true" />
                <span className="flex items-center justify-between gap-1">
                  {item.label}
                  {item.placeholder && <span className="text-xs font-normal text-muted-foreground">Coming later</span>}
                </span>
              </NavLink>
            );
          })}
        </nav>
        <div className="mt-4 border-t pt-3">
          <UserBlock onNavigate={() => setMoreOpen(false)} />
        </div>
      </Dialog>
    </>
  );
}

/** Files chosen on this device that are not yet on the shop PC (all expenses). */
function PendingAttachments() {
  const { user } = useAuth();
  const { queue, items } = useAttachmentQueue();
  // Attachments postponed: no queue runs; only say whether this browser still holds unsent files.
  if (!billAttachmentsEnabled()) return user ? <PausedDeviceFilesNotice userId={user.id} /> : null;
  return <AttachmentSyncBanner items={items} onRetry={() => void queue?.syncNow({ force: true })} />;
}

/** Responsive application frame: sidebar on md+ screens, top bar + bottom navigation on phones. */
export function AppShell() {
  const { user } = useAuth();
  // Bill attachments are postponed: no offline queue, no background sync (docs/bill-attachments-postponed.md).
  if (!user || !billAttachmentsEnabled()) return <AppFrame />;
  // The offline attachment queue belongs to the signed-in user (other users of this browser never see it).
  return (
    <AttachmentQueueProvider userId={user.id}>
      <AppFrame />
    </AttachmentQueueProvider>
  );
}

function AppFrame() {
  return (
    <ShortcutsProvider>
      <AppFrameContent />
    </ShortcutsProvider>
  );
}

/** A keyboard-shortcut hint, shown only on desktop-class devices. */
function Kbd({ children }: { children: string }) {
  return (
    <kbd className="ml-auto rounded border border-current/25 px-1 font-mono text-[0.6875rem] leading-4 opacity-80" aria-hidden="true">
      {children}
    </kbd>
  );
}

function AppFrameContent() {
  const shortcuts = useShortcuts();
  const { user } = useAuth();
  const location = useLocation();
  const items = navItemsFor(user?.role);
  // Changes made on other phones refresh this one, with a small notification (Features 1 and 3).
  useLiveUpdates();

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r bg-card md:flex">
        <div className="px-5 pb-3 pt-4">
          <Brand />
        </div>
        <div className="px-3 pb-2">
          <Link
            to="/expenses/new"
            aria-keyshortcuts={shortcuts.desktop ? 'F2' : undefined}
            className="flex h-10 items-center justify-between gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground shadow-[0_1px_2px_oklch(0.3_0.06_170/0.25),inset_0_1px_0_oklch(1_0_0/0.12)] transition-[background-color,transform] duration-150 hover:bg-primary-hover active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <span className="flex items-center gap-2">
              <Plus className="size-4" strokeWidth={2.5} aria-hidden="true" />
              Add expense
            </span>
            {shortcuts.desktop ? <Kbd>F2</Kbd> : <ChevronRight className="size-4 opacity-70" aria-hidden="true" />}
          </Link>
          <button
            type="button"
            onClick={shortcuts.openQuickLookup}
            aria-keyshortcuts={shortcuts.desktop ? 'F4' : undefined}
            className="mt-1.5 flex h-9 w-full items-center gap-2 rounded-lg border bg-card px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Search className="size-4" aria-hidden="true" />
            Product lookup
            {shortcuts.desktop && <Kbd>F4</Kbd>}
          </button>
        </div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-2">
          {NAV_GROUPS.map((group) => {
            const groupItems = items.filter((i) => i.group === group);
            if (groupItems.length === 0) return null;
            return (
              <div key={group} className="space-y-px">
                <p className="eyebrow px-3 pb-0.5">{group}</p>
                {groupItems.map((item) => (
                  <SidebarLink key={item.to} item={item} />
                ))}
              </div>
            );
          })}
        </nav>
        <div className="border-t p-2">
          {shortcuts.desktop && (
            <button
              type="button"
              onClick={shortcuts.openHelp}
              className="mb-1 flex h-8 w-full items-center gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Keyboard className="size-3.5" aria-hidden="true" /> Keyboard shortcuts
            </button>
          )}
          <UserBlock compact />
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-10 flex h-[calc(var(--mobile-header-height)+env(safe-area-inset-top))] items-center justify-between border-b bg-card/90 px-4 pt-[env(safe-area-inset-top)] backdrop-blur-md md:hidden">
          <Brand />
          <button
            type="button"
            onClick={shortcuts.openQuickLookup}
            aria-label="Product lookup"
            className="inline-flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Search className="size-5" aria-hidden="true" />
          </button>
        </header>
        <main className="pb-bottom-nav flex-1 px-4 pt-5 md:px-8 md:pb-12 md:pt-8 lg:px-10">
          <PendingAttachments />
          {/* Each screen eases in (opacity + a few pixels of rise); navigation itself is never delayed. */}
          <div key={location.pathname} className="animate-page-in">
            <Outlet />
          </div>
        </main>
      </div>

      <BottomNav items={items} />
    </div>
  );
}
