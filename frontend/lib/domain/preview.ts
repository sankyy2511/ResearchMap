/**
 * Where page images come from.
 * - Snapshot: the Chrome extension sends real JPEG snapshots (§13.1). Until it is connected,
 *   we fall back to the page's og:image, then to a free public screenshot service (WordPress mShots).
 * - Favicon: Google's public favicon service, with a letter tile fallback in the UI.
 */
import type { Page } from "@/types/api";

export function screenshotUrl(page: Pick<Page, "url" | "og_image_url">, width = 640, bust = 0): string {
  if (page.og_image_url) return page.og_image_url;
  return `https://s0.wp.com/mshots/v1/${encodeURIComponent(page.url)}?w=${width}&h=${Math.round(width * 0.66)}${bust ? `&r=${bust}` : ""}`;
}

export function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}
