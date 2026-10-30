/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API base URL. Defaults to the same-origin "/api/v1". */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
