/**
 * The empty application shell may be previewed without signing in, in development builds only.
 * `import.meta.env.DEV` is false in production builds, so this can never be true there.
 */
export function isShellPreviewEnabled(
  env: { DEV: boolean; VITE_PREVIEW_SHELL?: string } = import.meta.env,
): boolean {
  return env.DEV === true && env.VITE_PREVIEW_SHELL === 'true';
}
