import { BookMarked } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';

/** Centred single-card screen for sign-in and password changes (outside the app shell). */
export function AuthLayout({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex items-center justify-center gap-2.5">
          <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-card">
            <BookMarked className="size-5" aria-hidden="true" />
          </span>
          <span className="text-lg font-semibold tracking-tight">Shop-Books</span>
        </div>
        <Card>
          <CardHeader className="pb-2 md:pb-2">
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </div>
    </main>
  );
}
