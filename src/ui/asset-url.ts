/**
 * Build the traversal-safe asset URL. `version` is an optional cache-bust token
 * (assets are served `no-store`, but a same-`src` <img> would never refetch).
 *
 * Lifted out of `AssetImage.tsx` by WS-20 (studio-actions-stable-routes) so the
 * pure, JSX-free `direction-actions.ts` builder module can reuse the exact same
 * encoding without a `.ts` → `.tsx` import (the server tsconfig has no `jsx`).
 * `AssetImage.tsx` re-exports it unchanged, so its public surface is identical.
 */
export function assetUrl(path: string, version?: number | string): string {
  return version != null
    ? `/api/asset?path=${encodeURIComponent(path)}&v=${encodeURIComponent(String(version))}`
    : `/api/asset?path=${encodeURIComponent(path)}`;
}
