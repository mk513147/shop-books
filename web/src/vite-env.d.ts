/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Where the Shop-Books API is (public; baked into the bundle at build time). Empty = same-origin
   * "/api/v1" (local development). For a deployed frontend: the API server's https origin, e.g. a
   * Cloudflare Tunnel URL. See src/lib/api-base-url.ts and docs/staging-deployment.md.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
