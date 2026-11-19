import { AlertTriangle } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { isChunkLoadError, reloadOnceForChunkError } from '@/features/system/app-update';

interface State {
  failed: boolean;
}

/** Last-resort handler so a rendering bug shows a message instead of a blank screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error', { name: error.name, componentStack: info.componentStack });
    // A file of the previous release that no longer exists after a deployment: load the new one
    // (at most once per few minutes, so a real outage cannot cause a reload loop).
    if (isChunkLoadError(error)) reloadOnceForChunkError();
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-destructive-soft text-destructive ring-1 ring-destructive/10">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </span>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          The page hit an unexpected problem. Reloading usually fixes it.
        </p>
        <Button className="mt-2 min-w-32" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
}
