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
      <div role="alert" className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          The page hit an unexpected problem. Reloading usually fixes it.
        </p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );
  }
}
