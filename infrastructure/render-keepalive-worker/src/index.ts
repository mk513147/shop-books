import { runKeepAlive } from './keepalive';

export interface Env {
  /** Render health endpoint (configuration, not a secret). */
  TARGET_URL: string;
}

function isUsableTarget(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    // https only in production; plain http is accepted solely for loopback (local tests with a fake target).
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname));
  } catch {
    return false;
  }
}

export default {
  /**
   * Cron Trigger entry point. Never throws, so one bad run cannot affect future scheduled executions.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!isUsableTarget(env.TARGET_URL)) {
      console.error(JSON.stringify({ event: 'render_keepalive', timestamp: new Date(controller.scheduledTime).toISOString(), success: false, error: 'TARGET_URL is missing or not an https URL' }));
      return;
    }
    ctx.waitUntil(runKeepAlive({ url: env.TARGET_URL, scheduledTime: controller.scheduledTime }));
  },

  /**
   * HTTP endpoint: GET /health only reports that THIS Worker is responding. It never contacts Render and
   * cannot be used to trigger a ping. Everything else is 404/405.
   */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== '/health') return Response.json({ error: 'not found' }, { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return Response.json({ error: 'method not allowed' }, { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    return Response.json({ status: 'ok', worker: 'shop-books-render-keepalive' }, { headers: { 'cache-control': 'no-store' } });
  },
} satisfies ExportedHandler<Env>;
