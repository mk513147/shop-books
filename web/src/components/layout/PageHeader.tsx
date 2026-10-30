import { ChevronLeft } from 'lucide-react';
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
    <div className="space-y-2">
      {back && (
        <Link
          to={back.to}
          className="-ml-1 inline-flex h-8 items-center gap-0.5 rounded-md pr-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight break-words md:text-2xl">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** Max-width wrapper so pages have consistent widths: `narrow` for forms/details, `wide` for lists. */
export function Page({ width = 'wide', children }: { width?: 'narrow' | 'medium' | 'wide'; children: ReactNode }) {
  const max = width === 'narrow' ? 'max-w-2xl' : width === 'medium' ? 'max-w-4xl' : 'max-w-6xl';
  return <div className={`mx-auto w-full ${max} space-y-5 md:space-y-6`}>{children}</div>;
}
