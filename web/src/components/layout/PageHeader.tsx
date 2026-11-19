import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** Consistent page title block: optional back link, title, description and actions. */
export function PageHeader({
  title,
  description,
  back,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  back?: { to: string; label: string };
  actions?: ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      {back && (
        <Link
          to={back.to}
          className="group -ml-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-4 transition-transform duration-150 group-hover:-translate-x-0.5" aria-hidden="true" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-[1.5rem] font-semibold leading-tight tracking-[-0.022em] break-words md:text-[1.75rem]">{title}</h1>
          {description && <div className="text-sm text-muted-foreground md:text-[0.9375rem]">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** Max-width wrapper so pages have consistent widths: `narrow` for forms/details, `wide` for lists. */
export function Page({ width = 'wide', children }: { width?: 'narrow' | 'medium' | 'wide'; children: ReactNode }) {
  const max = width === 'narrow' ? 'max-w-2xl' : width === 'medium' ? 'max-w-4xl' : 'max-w-6xl';
  return <div className={`mx-auto w-full ${max} space-y-5 md:space-y-7`}>{children}</div>;
}

/** Titled group inside a page ("Current balances", "Payment history"). */
export function PageSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className ? `space-y-3 ${className}` : 'space-y-3'}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-[-0.01em]">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
