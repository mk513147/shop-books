import { Link } from 'react-router-dom';
import { buttonVariants } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md animate-page-in flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="figure rounded-full bg-primary-soft px-3 py-1 text-xs font-semibold text-primary-soft-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">Page not found</h1>
      <p className="text-sm text-muted-foreground">The page you are looking for does not exist.</p>
      <Link to="/" className={buttonVariants({ variant: 'outline', className: 'mt-2 w-fit' })}>
        Go to the start page
      </Link>
    </main>
  );
}
