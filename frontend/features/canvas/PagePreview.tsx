"use client";
/**
 * Live tab preview inside a node (§13): Snapshot (default), Live Video, Interactive.
 * Shows the real website: extension snapshot when available, otherwise a real screenshot.
 */
import { memo, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { API_MODE } from "@/lib/api/config";
import { pageApi } from "@/lib/api/capture";
import { extensionBridge } from "@/lib/extension/bridge";
import { normalizeUrl } from "@/lib/utils/url";
import { useExtensionStore } from "@/stores/extension";
import { Prohibit } from "@phosphor-icons/react";
import type { Page } from "@/types/api";
import { colorFromString } from "@/lib/domain/meta";
import { faviconUrl, screenshotUrl } from "@/lib/domain/preview";
import type { PreviewMode } from "@/stores/extension";

export function Favicon({ page, size = 16 }: { page: Pick<Page, "domain" | "site_name"> & { favicon_url?: string | null }; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        className="inline-grid shrink-0 place-items-center rounded-[30%] font-bold text-white"
        style={{ width: size, height: size, background: colorFromString(page.domain), fontSize: size * 0.55 }}
        aria-hidden
      >
        {(page.site_name ?? page.domain)[0]?.toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={(page as Partial<Page>).favicon_url || faviconUrl(page.domain)} alt="" width={size} height={size} className="shrink-0 rounded-sm" loading="lazy" onError={() => setFailed(true)} />
  );
}

/** Real screenshot of the site. The screenshot service may first return a "generating" image, so we refresh once. */
function SiteShot({ page, live, refreshMs }: { page: Page; live?: boolean; refreshMs?: number }) {
  const [bust, setBust] = useState(0);
  const [tries, setTries] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  // Real-time tab view: while the tab is open in the browser, keep pulling a fresh snapshot.
  useEffect(() => {
    if (!refreshMs) return;
    const t = setInterval(() => setBust(Date.now()), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs]);
  // The service generates screenshots on first request: it errors or returns a 400px
  // placeholder until ready, so poll a few times before falling back.
  const retry = () => {
    if (tries >= 5) return setFailed(true);
    setTimeout(() => {
      setTries((t) => t + 1);
      setBust(Date.now());
    }, 3000 + tries * 2000);
  };
  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas-cool">
      {!loaded && !failed && <div className="skeleton absolute inset-0 rounded-none" />}
      {failed ? (
        <div className="grid h-full place-items-center p-3 text-center">
          <div>
            <Favicon page={page} size={28} />
            <p className="mt-1 line-clamp-2 text-[11px] font-semibold text-muted">{page.title}</p>
          </div>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={screenshotUrl(page, 640, bust)}
          alt={`Snapshot of ${page.title}`}
          loading="lazy"
          draggable={false}
          decoding="async"
          className="h-full w-full object-cover object-top text-transparent"
          onLoad={(e) => {
            setLoaded(true);
            if (!page.og_image_url && e.currentTarget.naturalWidth < 600) retry();
          }}
          onError={retry}
        />
      )}
      {live && (
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-danger px-2 py-0.5 text-[10px] font-extrabold tracking-wider text-white shadow-soft">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> LIVE
        </span>
      )}
    </div>
  );
}

/** Real-time video of the tab (chrome.tabCapture stream id sent by the extension). */
function LiveVideo({ streamId, url }: { streamId: string; url: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId, maxWidth: 640, maxHeight: 400, maxFrameRate: 5 } } } as unknown as MediaStreamConstraints)
      .then((s) => {
        stream = s;
        if (ref.current) ref.current.srcObject = s;
        s.getVideoTracks()[0]?.addEventListener("ended", () => useExtensionStore.getState().setLiveStream(url, null));
      })
      .catch(() => useExtensionStore.getState().setLiveStream(url, null));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [streamId, url]);
  return (
    <div className="relative h-full w-full bg-black">
      <video ref={ref} autoPlay muted playsInline className="h-full w-full object-cover object-top" />
      <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-danger px-2 py-0.5 text-[10px] font-extrabold tracking-wider text-white"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> LIVE</span>
    </div>
  );
}

/** Real mode: extension snapshot (instant) → saved server snapshot → og:image → clean card. No third-party screenshot service. */
function RealPreview({ page, mode, image }: { page: Page; mode: PreviewMode; image?: string | null }) {
  const key = normalizeUrl(page.url);
  const snap = useExtensionStore((s) => s.snapshots[key]);
  const stream = useExtensionStore((s) => s.liveStreams[key]);
  const server = useQuery({
    queryKey: ["preview", page.id, page.preview_captured_at],
    queryFn: () => pageApi.getPreview(page.id),
    enabled: !snap && !image && !!page.preview_captured_at,
    staleTime: 60_000,
  });
  if (mode === "live" && stream) return <LiveVideo streamId={stream} url={key} />;
  const src = image || snap || server.data?.image || page.og_image_url;
  if (src) {
    return (
      <div className="relative h-full w-full overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={`Snapshot of ${page.title}`} className="h-full w-full object-cover object-top" draggable={false} />
        {mode === "live" && <span className="absolute inset-x-0 bottom-0 bg-ink/80 px-2 py-1 text-[10px] font-bold text-white">Press Alt+Shift+L on the tab to stream it live</span>}
      </div>
    );
  }
  return (
    <div className="grid h-full place-items-center bg-canvas-cool p-3 text-center">
      <div>
        <Favicon page={page} size={28} />
        <p className="mt-1 line-clamp-2 text-[11px] font-semibold text-muted">{page.title}</p>
        <p className="text-[10px] text-muted">Preview appears when you open this tab</p>
      </div>
    </div>
  );
}

export const PagePreview = memo(function PagePreview({ page, mode, image, refreshMs }: { page: Page; mode: PreviewMode; image?: string | null; refreshMs?: number }) {
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const blocked = blockedUrl === page.url;
  useEffect(() => {
    if (API_MODE === "http" && mode === "interactive") extensionBridge.enableEmbed(page.url);
  }, [mode, page.url]);

  if (mode === "interactive") {
    if (!page.embeddable || blocked) {
      return (
        <div className="relative h-full">
          {API_MODE === "http" ? <RealPreview page={page} mode="snapshot" /> : <SiteShot page={page} />}
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-ink/80 px-2 py-1 text-[10px] font-bold text-white">
            <Prohibit size={12} weight="bold" /> This site cannot be embedded.
          </div>
        </div>
      );
    }
    return (
      <iframe
        src={page.url}
        title={`Interactive view of ${page.title}`}
        className="nodrag nowheel h-full w-full bg-white"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setBlockedUrl(page.url)}
      />
    );
  }
  if (API_MODE === "http") return <RealPreview page={page} mode={mode} image={image} />;
  if (image) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={image} alt={`Snapshot of ${page.title}`} className="h-full w-full object-cover object-top" />;
  }
  return <SiteShot page={page} live={mode === "live"} refreshMs={mode === "live" ? 8000 : refreshMs} />;
});
