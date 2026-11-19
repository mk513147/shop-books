import { LockKeyhole } from 'lucide-react';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/layout/AppShell';

/** Centred single-card screen for sign-in and password changes (outside the app shell). */
export function AuthLayout({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-background px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]">
      {/* One quiet wash of the accent at the top: depth without decoration. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(60%_100%_at_50%_0%,oklch(0.93_0.04_170/0.7),transparent)]"
      />
      <div className="relative w-full max-w-[25rem] animate-rise-in space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark className="size-11 rounded-xl [&_svg]:size-5" />
          <span className="text-lg font-semibold tracking-[-0.02em]">Shop-Books</span>
        </div>
        <div className="rounded-2xl border bg-card p-5 shadow-[0_1px_2px_oklch(0.25_0.02_250/0.05),0_12px_32px_oklch(0.25_0.02_250/0.06)] sm:p-7">
          <div className="mb-5 space-y-1.5">
            <h1 className="text-xl font-semibold tracking-[-0.02em]">{title}</h1>
            <div className="text-sm text-muted-foreground">{description}</div>
          </div>
          {children}
        </div>
        <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <LockKeyhole className="size-3.5" aria-hidden="true" />
          Private to the shop · secure connection
        </p>
      </div>
    </main>
  );
}
