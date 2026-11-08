import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/features/auth/auth-context';
import { LiveUpdates } from './live-updates';

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;

/**
 * Keeps the signed-in app in step with changes made on other phones (see live-updates.ts).
 * Mounted once, inside the authenticated layout.
 */
export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const toast = useToast();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (userId === null) return;
    const live = new LiveUpdates({ queryClient, userId, notify: toast });
    const onVisibility = () => live.setHidden(document.visibilityState === 'hidden');
    const onActivity = () => live.touch();
    const onOnline = () => live.wake();
    live.setHidden(document.visibilityState === 'hidden');
    live.start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onOnline);
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, { passive: true });
    return () => {
      live.stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onOnline);
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity);
    };
  }, [queryClient, userId, toast]);
}
