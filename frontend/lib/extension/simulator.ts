"use client";
/**
 * Demo browsing simulator. While tracking is ON it behaves like the Chrome extension:
 * search → POST /capture/search, dwell ≥ min seconds → POST /capture/page, and flushes
 * visits every few seconds → POST /capture/visits. It uses the public API only.
 */
import { captureApi } from "@/lib/api/capture";
import { normalizeUrl } from "@/lib/utils/url";
import { BROWSING_SCRIPT, type ScriptStep } from "@/mock/data/library";
import { useExtensionStore } from "@/stores/extension";

interface Run {
  workspaceId: string;
  sessionId: string;
  step: number;
  paused: boolean;
  timer?: ReturnType<typeof setTimeout>;
  flushTimer?: ReturnType<typeof setInterval>;
  current: { url: string; since: number } | null;
  lastSearchUrl: string | null;
  urlByKey: Record<string, string>;
}

let run: Run | null = null;
export const SIM_DWELL_MS = 6000;

function setTabs() {
  if (!run) return;
  const tabs: Record<string, "active" | "open"> = {};
  Object.values(run.urlByKey).forEach((u) => (tabs[normalizeUrl(u)] = "open"));
  if (run.current) tabs[normalizeUrl(run.current.url)] = "active";
  useExtensionStore.getState().setTabs(tabs);
}

async function flushVisit() {
  if (!run?.current || run.paused) return;
  const now = Date.now();
  const { url, since } = run.current;
  run.current.since = now;
  try {
    await captureApi.visits({
      session_id: run.sessionId,
      visits: [{ url, tab_id: 1, started_at: new Date(since).toISOString(), ended_at: new Date(now).toISOString() }],
    });
  } catch {
    /* extension retries next flush */
  }
}

async function doStep(step: ScriptStep) {
  if (!run) return;
  if (step.kind === "search") {
    const url = `https://www.google.com/search?q=${encodeURIComponent(step.query)}`;
    run.lastSearchUrl = url;
    await captureApi.search({ query: step.query, engine: step.engine, url, workspace_id: run.workspaceId });
    return;
  }
  await flushVisit();
  const openerUrl =
    step.opener === "search" ? run.lastSearchUrl : step.opener ? (run.urlByKey[step.opener] ?? null) : null;
  run.current = { url: step.page.url, since: Date.now() };
  run.urlByKey[step.page.key] = step.page.url;
  setTabs();
  // Wait the minimum dwell time (8 s rule, shortened for the demo) before capturing.
  await new Promise((r) => (run!.timer = setTimeout(r, SIM_DWELL_MS)));
  if (!run || run.paused) return;
  const query = step.opener === "search" && run.lastSearchUrl ? decodeURIComponent(run.lastSearchUrl.split("q=")[1] ?? "") : null;
  await captureApi.page({
    workspace_id: run.workspaceId,
    url: step.page.url,
    title: step.page.title,
    meta: { site_name: step.page.site_name, description: step.page.summary },
    content_text: step.page.content,
    opener_url: openerUrl,
    search_query: query,
    transition: step.opener === "search" ? "search_result" : step.opener ? "link" : "typed",
    tab_id: 1,
    captured_at: new Date().toISOString(),
    // demo-only hints so the mock AI can replay the prepared analysis
    ...({ _lib_key: step.page.key, _conflict_with: step.conflictWith } as object),
  });
  await flushVisit();
}

async function loop() {
  if (!run || run.paused) return;
  const step = BROWSING_SCRIPT[run.step];
  if (!step) return; // script finished; keep counting time on the last page
  run.step++;
  try {
    await doStep(step);
  } catch {
    /* capture errors are shown by the canvas; continue */
  }
  if (run && !run.paused) run.timer = setTimeout(loop, step.kind === "search" ? 2500 : 4000);
}

export const browsingSimulator = {
  start(workspaceId: string, sessionId: string) {
    this.stop();
    run = { workspaceId, sessionId, step: 0, paused: false, current: null, lastSearchUrl: null, urlByKey: {} };
    run.flushTimer = setInterval(() => void flushVisit(), 5000);
    run.timer = setTimeout(loop, 1200);
  },
  pause() {
    if (!run) return;
    void flushVisit();
    run.paused = true;
    if (run.timer) clearTimeout(run.timer);
  },
  resume() {
    if (!run) return;
    run.paused = false;
    if (run.current) run.current.since = Date.now();
    run.timer = setTimeout(loop, 800);
  },
  stop() {
    if (!run) return;
    void flushVisit();
    if (run.timer) clearTimeout(run.timer);
    if (run.flushTimer) clearInterval(run.flushTimer);
    run = null;
    useExtensionStore.getState().setTabs({});
  },
  isRunning: (workspaceId: string) => run?.workspaceId === workspaceId,
  openTabs: () => (run ? Object.values(run.urlByKey) : []),
};
