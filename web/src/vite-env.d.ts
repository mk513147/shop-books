/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API base URL. Defaults to the same-origin "/api/v1". */
  readonly VITE_API_URL?: string;
  /** Development-only: preview the empty application shell without authentication. */
  readonly VITE_PREVIEW_SHELL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
