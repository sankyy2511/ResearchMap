// Research Map extension (MV3). Captures only while the user tracks a workspace. No AI, no database here.
const SEARCH_ENGINES = [
  { host: /(^|\.)google\.[a-z.]+$/, path: /^\/search/, param: "q", name: "google" },
  { host: /(^|\.)bing\.com$/, path: /^\/search/, param: "q", name: "bing" },
  { host: /(^|\.)duckduckgo\.com$/, path: /^\/$/, param: "q", name: "duckduckgo" },
  { host: /(^|\.)search\.brave\.com$/, path: /^\/search/, param: "q", name: "brave" },
  { host: /(^|\.)youtube\.com$/, path: /^\/results/, param: "search_query", name: "youtube" },
  { host: /(^|\.)scholar\.google\.[a-z.]+$/, path: /^\/scholar/, param: "q", name: "scholar" },
];
const ports = new Set();
let dwellTimer = null;

/* ---------------- storage helpers (service worker may stop at any time, so state lives in storage) */
const get = (k) => chrome.storage.local.get(k);
const set = (o) => chrome.storage.local.set(o);
const sget = (k) => chrome.storage.session.get(k);
const sset = (o) => chrome.storage.session.set(o);

async function api(method, path, body) {
  const { token, apiBase } = await get(["token", "apiBase"]);
  if (!token || !apiBase) throw new Error("not connected");
  const res = await fetch(apiBase + path, {
    method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  // The token was removed (account deleted or signed out): forget it so the web app connects again.
  if (res.status === 401) await set({ token: null, userId: null });
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || res.status), { status: res.status });
  return data;
}

/* ---------------- outbox: captures survive Go being down and service-worker restarts */
const RETRYABLE = (e) => !e.status || e.status >= 500 || e.status === 429;
async function sendOrQueue(method, path, body) {
  try { return await api(method, path, body); }
  catch (e) {
    if (!RETRYABLE(e)) throw e;
    const { outbox = [] } = await get("outbox");
    outbox.push({ method, path, body, tries: 0 });
    await set({ outbox: outbox.slice(-100) });
    console.warn("[EXTENSION] backend unreachable, queued", path);
    return null;
  }
}
async function flushOutbox() {
  const { outbox = [] } = await get("outbox");
  if (!outbox.length) return;
  const keep = [];
  for (const item of outbox) {
    try {
      const res = await api(item.method, item.path, item.body);
      if (item.path === "/capture/page" && res?.page_id) await rememberCaptured(item.body.url, res.page_id);
      console.info("[EXTENSION] queued item delivered", item.path);
    } catch (e) {
      if (RETRYABLE(e) && item.tries < 20) keep.push({ ...item, tries: item.tries + 1 });
    }
  }
  await set({ outbox: keep });
}
async function rememberCaptured(url, value) {
  const { captured = {} } = await get("captured");
  await set({ captured: { ...captured, [normalizeUrl(url)]: value } });
}

/* ---------------- URL rules (same as backend urlnorm + frontend url.ts) */
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    [...u.searchParams.keys()].forEach((k) => { if (k.startsWith("utm_") || k === "fbclid" || k === "gclid") u.searchParams.delete(k); });
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    let s = u.toString();
    return s.endsWith("/") ? s.slice(0, -1) : s;
  } catch { return raw; }
}
const isHttp = (u) => /^https?:\/\//i.test(u || "");
function searchOf(url) {
  try {
    const u = new URL(url);
    const e = SEARCH_ENGINES.find((s) => s.host.test(u.hostname) && s.path.test(u.pathname));
    const q = e && u.searchParams.get(e.param);
    return q ? { query: q.trim(), engine: e.name } : null;
  } catch { return null; }
}

async function state() {
  return get(["tracking", "paused", "workspaceId", "sessionId", "blocklist", "captured", "goal", "webOrigin"]);
}
async function allowed(url, tab) {
  const s = await state();
  if (tab?.incognito) return false; // never track incognito (manifest also sets incognito: not_allowed)
  if (!s.tracking || s.paused || !s.workspaceId || !isHttp(url)) return false;
  if (s.webOrigin && new URL(url).origin === s.webOrigin) return false; // never capture our own app
  const host = new URL(url).hostname.replace(/^www\./, "");
  return !(s.blocklist || []).some((b) => host === b || host.endsWith("." + b));
}

/* ---------------- web app bridge */
function broadcast(msg) { ports.forEach((p) => { try { p.postMessage(msg); } catch { ports.delete(p); } }); }

chrome.runtime.onConnectExternal.addListener((port) => {
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  if (port.sender?.tab?.id) set({ webTabId: port.sender.tab.id });
  sendTabsState();
  state().then((s) => port.postMessage({ type: "TRACKING_STATE", tracking: !!s.tracking, paused: !!s.paused, workspace_id: s.workspaceId || null }));
});

chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  handleExternal(msg, sender).then(reply, (e) => reply({ ok: false, error: String(e.message || e) }));
  return true;
});

async function handleExternal(msg, sender) {
  switch (msg?.type) {
    case "PING": {
      const { token, userId } = await get(["token", "userId"]);
      return { ok: true, version: chrome.runtime.getManifest().version, connected: !!token, user_id: userId || null };
    }
    case "RELOAD": // the web app needs newer code: reload this unpacked extension from its folder
      setTimeout(() => chrome.runtime.reload(), 100);
      return { ok: true };
    case "CONNECT_TOKEN":
      // The web app sends its API address; without one, the API is reached through the app itself.
      await set({ token: msg.token, userId: msg.user_id || null, apiBase: msg.api_base || sender.origin + "/api/v1", webOrigin: sender.origin });
      await syncState();
      return { ok: true };
    case "START_TRACKING": {
      const ws = await api("GET", "/workspaces").then((l) => l.find((w) => w.id === msg.workspace_id)).catch(() => null);
      // Re-sent when the web app reloads during the same session: keep the captured cache instead of wiping it.
      const prev = await state();
      const same = prev.tracking && prev.workspaceId === msg.workspace_id && prev.sessionId === msg.session_id;
      await set({ tracking: true, paused: false, workspaceId: msg.workspace_id, sessionId: msg.session_id,
        blocklist: ws?.settings?.blocklist || [], captured: same ? prev.captured || {} : {},
        goal: typeof msg.goal === "string" ? msg.goal : same ? prev.goal || "" : "" });
      if (!same) await sset({ goalChecks: {}, goalWarned: {}, offGoal: false });
      notifyTracking();
      // Give the user a fresh normal tab to research in. chrome://newtab is not http(s), so it is never captured itself.
      let openedTabId = null;
      if (msg.open_tab !== false) {
        try {
          const tab = await chrome.tabs.create({ active: true });
          openedTabId = tab.id;
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch (e) { console.warn("[EXTENSION] could not open tracking tab", e); }
      }
      checkActiveTab();
      return { ok: true, tab_id: openedTabId };
    }
    case "PAUSE_TRACKING": await set({ paused: true }); await serial(async () => { await endVisit(); await cancelDwell(); }); notifyTracking(); return { ok: true };
    case "RESUME_TRACKING": await set({ paused: false }); notifyTracking(); checkActiveTab(); return { ok: true };
    case "STOP_TRACKING": await serial(async () => { await endVisit(); await cancelDwell(); }); await flushVisits(); await flushOutbox(); await set({ tracking: false, paused: false, sessionId: null, goal: "" }); await sset({ offGoal: false }); notifyTracking(); return { ok: true };
    case "GOAL_CHANGED": await set({ goal: msg.goal || "" }); await sset({ goalChecks: {}, goalWarned: {}, offGoal: false }); notifyTracking(); checkActiveTab(); return { ok: true };
    case "GET_OPEN_TABS": {
      const tabs = (await chrome.tabs.query({})).filter((t) => isHttp(t.url) && !t.incognito);
      sendTabsState();
      return { ok: true, tabs: tabs.map((t) => ({ url: t.url, url_normalized: normalizeUrl(t.url), title: t.title, active: t.active })) };
    }
    case "FOCUS_TAB": {
      const tab = await findTab(msg.url);
      if (!tab) { await chrome.tabs.create({ url: msg.url }); return { ok: true, opened: true }; }
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true };
    }
    case "OPEN_URLS_AS_GROUP": {
      const ids = [];
      for (const u of (msg.urls || []).filter(isHttp).slice(0, 30)) ids.push((await chrome.tabs.create({ url: u, active: false })).id);
      if (ids.length) {
        const g = await chrome.tabs.group({ tabIds: ids });
        await chrome.tabGroups.update(g, { title: (msg.title || "Research").slice(0, 40), color: "purple" });
      }
      return { ok: true, opened: ids.length };
    }
    case "CLOSE_SAVED_TABS": {
      const want = new Set((msg.urls || []).map(normalizeUrl));
      const tabs = (await chrome.tabs.query({})).filter((t) => want.has(normalizeUrl(t.url || "")));
      await chrome.tabs.remove(tabs.map((t) => t.id));
      return { ok: true, closed: tabs.length };
    }
    case "REQUEST_LIVE_VIDEO": {
      const tab = await findTab(msg.url);
      if (!tab) return { ok: false, error: "Tab not open" };
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true, hint: "Press Alt+Shift+L on that tab to start the live view (Chrome requires this click)." };
    }
    case "ENABLE_INTERACTIVE_EMBED": {
      // Remove frame-blocking headers ONLY for iframes that our web app opens (session rule, gone when Chrome closes).
      const { webOrigin } = await get("webOrigin");
      if (!webOrigin) return { ok: false, error: "not connected" };
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [1],
        addRules: [{ id: 1, priority: 1,
          action: { type: "modifyHeaders", responseHeaders: [{ header: "x-frame-options", operation: "remove" }, { header: "content-security-policy", operation: "remove" }] },
          condition: { resourceTypes: ["sub_frame"], initiatorDomains: [new URL(webOrigin).hostname] } }],
      });
      return { ok: true };
    }
  }
  return { ok: false, error: "unknown message" };
}

async function syncState() {
  // After a browser restart, resume the tracking session the backend says is active.
  try {
    const st = await api("GET", "/extension/state");
    if (st.session && st.session.state !== "stopped") {
      await set({ tracking: true, paused: st.session.state === "paused", workspaceId: st.session.workspace_id, sessionId: st.session.id,
        blocklist: st.workspace?.settings?.blocklist || [], goal: st.session.goal || "" });
    } else await set({ tracking: false });
    notifyTracking();
  } catch { /* offline or not connected */ }
}

async function notifyTracking() {
  const s = await state();
  const { offGoal } = await sget("offGoal");
  const off = s.tracking && !s.paused && s.goal && offGoal;
  chrome.action.setBadgeText({ text: s.tracking ? (s.paused ? "II" : off ? "!" : "ON") : "" });
  chrome.action.setBadgeBackgroundColor({ color: s.paused ? "#888" : off ? "#d9822b" : "#3f8a2e" });
  chrome.action.setTitle({ title: off ? "Research Map: this page is not part of your goal" : "Research Map" });
  broadcast({ type: "TRACKING_STATE", tracking: !!s.tracking, paused: !!s.paused, workspace_id: s.workspaceId || null });
}

async function findTab(url) {
  const n = normalizeUrl(url);
  return (await chrome.tabs.query({})).find((t) => normalizeUrl(t.url || "") === n);
}

async function sendTabsState() {
  const tabs = await chrome.tabs.query({});
  const out = {};
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  tabs.forEach((t) => { if (isHttp(t.url)) out[normalizeUrl(t.url)] = "open"; });
  if (active && isHttp(active.url)) out[normalizeUrl(active.url)] = "active";
  broadcast({ type: "TABS_STATE", tabs: out });
}

/* ---------------- time tracking: visits while tab active + window focused + user not idle */
async function startVisit(tab) {
  const { visit } = await sget("visit");
  // Repeated events for the page already being visited (load events, SPA title updates) must not split the visit.
  if (visit && tab && visit.tab_id === tab.id && normalizeUrl(visit.url) === normalizeUrl(tab.url || "")) return;
  await endVisit();
  if (!tab || !(await allowed(tab.url, tab))) return;
  await sset({ visit: { url: tab.url, tab_id: tab.id, started_at: new Date().toISOString() } });
}
async function endVisit() {
  const { visit } = await sget("visit");
  if (!visit) return;
  await sset({ visit: null });
  const v = { ...visit, ended_at: new Date().toISOString() };
  if (Date.parse(v.ended_at) - Date.parse(v.started_at) < 2000) return;
  const { pending = [] } = await get("pending");
  pending.push(v);
  await set({ pending: pending.slice(-500) });
}
async function flushVisits() {
  const { visit } = await sget("visit");
  if (visit) { await endVisit(); await sset({ visit: { ...visit, started_at: new Date().toISOString() } }); } // checkpoint
  const { pending = [], sessionId } = await get(["pending", "sessionId"]);
  if (!pending.length || !sessionId) return;
  try { await api("POST", "/capture/visits", { session_id: sessionId, visits: pending }); await set({ pending: [] }); }
  catch (e) { if (e.status && e.status < 500) await set({ pending: [] }); } // keep for retry when offline
}

/* ---------------- capture */
// Browser events arrive in bursts (onUpdated fires several times per load; onCommitted/onHistoryStateUpdated/onUpdated
// all report one navigation). Every state transition runs through one queue so handlers never interleave their
// storage read-modify-writes, and a burst collapses into a single active-tab check.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn).catch((e) => console.warn("[EXTENSION] state update failed", e?.message || e)));
let checkQueued = false;
function checkActiveTab() {
  if (checkQueued) return queue;
  checkQueued = true;
  return serial(() => { checkQueued = false; return doCheckActiveTab(); });
}
const DWELL_SECONDS = 5; // a page is added to the canvas after this long on screen
function armDwell(due) {
  clearTimeout(dwellTimer);
  dwellTimer = setTimeout(() => serial(checkDwell), Math.max(0, due - Date.now()) + 50);
}
async function cancelDwell() {
  clearTimeout(dwellTimer);
  await sset({ dwell: null });
}
const capturing = new Set(); // normalized URLs with a capture request in flight

async function doCheckActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  await startVisit(tab);
  if (!tab || !(await allowed(tab.url, tab))) { await privateSiteGoal(tab); return cancelDwell(); }
  const s = await state();
  const search = searchOf(tab.url);
  await scheduleGoalCheck(tab, s, search);
  if (search) return cancelDwell(); // search pages are not added to the map; the pages opened from them are
  const norm = normalizeUrl(tab.url);
  if ((s.captured || {})[norm] || capturing.has(norm)) { await cancelDwell(); if (tab.status === "complete") snapshot(tab); return; }
  const { dwell } = await sget("dwell");
  // Same page still pending: keep its deadline. Restarting it on every load/title event is what kept slow or
  // chatty pages (YouTube, Reddit, ad-heavy sites) from ever reaching the dwell time.
  if (dwell && dwell.tabId === tab.id && normalizeUrl(dwell.url) === norm) { armDwell(dwell.due); return; }
  // The clock starts when the page is committed and shown, not when every subresource finished loading.
  // The due time is persisted so a service-worker restart does not lose the pending capture.
  const due = Date.now() + DWELL_SECONDS * 1000;
  await sset({ dwell: { tabId: tab.id, url: tab.url, due } });
  console.info("[EXTENSION] dwell started", { tab_id: tab.id, seconds: DWELL_SECONDS });
  armDwell(due);
}
async function checkDwell() {
  const { dwell } = await sget("dwell");
  if (!dwell || Date.now() < dwell.due) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  // Still the same page, still active + focused, user not idle -> dwell satisfied.
  if (!tab || tab.id !== dwell.tabId || normalizeUrl(tab.url) !== normalizeUrl(dwell.url)) return cancelDwell();
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!win?.focused) return cancelDwell();
  if ((await chrome.idle.queryState(60)) !== "active") return cancelDwell();
  // Dwell is satisfied but the page is still loading: give it a few more seconds so extraction sees the content.
  if (tab.status !== "complete" && (dwell.waits || 0) < 5) {
    const due = Date.now() + 1500;
    await sset({ dwell: { ...dwell, due, waits: (dwell.waits || 0) + 1 } });
    return armDwell(due);
  }
  await cancelDwell();
  console.info("[EXTENSION] dwell satisfied", { tab_id: tab.id });
  capturePage(tab.id, "link"); // not awaited: extraction + upload must not hold up navigation handling
}

// One handler for every top-frame URL change (full navigation or SPA history.pushState/replaceState).
// trail[tabId] = the pages this tab has shown, oldest first, so a page can be linked to the page it really came from
// even when the page just before it was skipped (redirect, search results, a page left too quickly).
async function noteNavigation(tabId, url) {
  const { trail = {} } = await sget("trail");
  const list = trail[tabId] || [];
  const norm = normalizeUrl(url);
  if (list.length && normalizeUrl(list[list.length - 1]) === norm) return; // same page (fragment/tracking change)
  const seen = list.findIndex((u) => normalizeUrl(u) === norm);
  // Going back to an earlier page: the next page branches from it, so cut the trail there.
  const next = seen >= 0 ? list.slice(0, seen + 1) : [...list, url].slice(-20);
  await sset({ trail: { ...trail, [tabId]: next } });
}

// A tab opened by a link starts its trail with the page the link was on, read at the moment of the click.
async function noteNewTab(tabId, sourceTabId) {
  const source = await chrome.tabs.get(sourceTabId).catch(() => null);
  if (!source?.url) return;
  const { trail = {} } = await sget("trail");
  await sset({ trail: { ...trail, [tabId]: [source.url] } });
}

async function forgetTab(tabId) {
  const { trail = {} } = await sget("trail");
  delete trail[tabId];
  await sset({ trail });
}

/** The page this one came from: the nearest earlier page in the trail that is on the canvas (or is a search). */
async function openerFor(tabId, url) {
  const { trail = {} } = await sget("trail");
  const { captured = {} } = await get("captured");
  const cur = normalizeUrl(url);
  const before = (trail[tabId] || []).filter((u) => normalizeUrl(u) !== cur).reverse();
  return before.find((u) => captured[normalizeUrl(u)] || searchOf(u)) || before[0] || null;
}

function extractPage() {
  const pick = (sel, attr = "content") => document.querySelector(sel)?.getAttribute(attr) || undefined;
  // Pages with a visible password field are login/account pages: never captured automatically.
  const sensitive = [...document.querySelectorAll("input[type=password]")].some((e) => e.offsetParent !== null);
  let text = "", byline;
  try {
    // Readability (vendor/Readability.js, injected first) = Firefox Reader View engine. Runs on a clone; the page is untouched.
    const art = typeof Readability === "function" ? new Readability(document.cloneNode(true)).parse() : null; // eslint-disable-line no-undef
    if (art?.textContent) { text = art.textContent; byline = art.byline || undefined; }
  } catch { /* fall back below */ }
  if (text.trim().length < 200) {
    const root = document.querySelector("article, main, [role=main]") || document.body;
    const clone = root.cloneNode(true);
    clone.querySelectorAll("script,style,noscript,nav,footer,header,aside,form,input,textarea,[type=password],[aria-hidden=true]").forEach((e) => e.remove());
    text = clone.innerText || clone.textContent || "";
  }
  text = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim().slice(0, 20000);
  return {
    title: document.title, text, sensitive,
    favicon: pick("link[rel~='icon']", "href") ? new URL(pick("link[rel~='icon']", "href"), location.href).href : location.origin + "/favicon.ico",
    meta: { description: pick("meta[name=description]") || pick("meta[property='og:description']"), og_image: pick("meta[property='og:image']"),
      site_name: pick("meta[property='og:site_name']"), author: pick("meta[name=author]") || byline, published_time: pick("meta[property='article:published_time']"),
      lang: document.documentElement.lang || undefined },
    links: [...document.querySelectorAll("a[href^='http']")].slice(0, 200).map((a) => a.href),
  };
}

async function capturePage(tabId, transition) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !(await allowed(tab.url, tab))) return;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (transition !== "manual" && active?.id !== tabId) return; // user left before the dwell time
  const norm = normalizeUrl(tab.url);
  if (capturing.has(norm)) return; // same page already being sent (e.g. dwell + Alt+Shift+A together)
  capturing.add(norm);
  try { await sendCapture(tab, tabId, transition); } finally { capturing.delete(norm); }
}
async function sendCapture(tab, tabId, transition) {
  const t0 = Date.now();
  console.info("[EXTENSION] capture started", { tab_id: tabId, transition });
  let page = { title: tab.title, text: "", meta: {}, links: [] };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["vendor/Readability.js"] }).catch(() => {});
    [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPage });
  } catch { /* PDFs / restricted pages: backend fetches text */ }
  if (page.sensitive && transition !== "manual") { console.info("[EXTENSION] skipped page with password field"); return; }
  const opener_url = await openerFor(tabId, tab.url);
  const search_query = opener_url ? searchOf(opener_url)?.query || null : null;
  const s = await state();
  try {
    const res = await sendOrQueue("POST", "/capture/page", {
      url: tab.url, title: page.title || tab.title, favicon_url: page.favicon, meta: Object.fromEntries(Object.entries(page.meta || {}).filter(([, v]) => v)),
      content_text: page.text, outgoing_links: page.links, opener_url, search_query, transition: search_query ? "search_result" : transition,
      tab_id: tabId, captured_at: new Date().toISOString(), workspace_id: s.workspaceId,
    });
    if (!res) return; // queued; delivered by the next flush
    await rememberCaptured(tab.url, res.page_id);
    console.info("[EXTENSION] capture sent", { node_id: res.node_id, page_id: res.page_id, is_new: res.is_new, ms: Date.now() - t0, chars: page.text?.length || 0 });
    snapshot(tab, res.page_id);
  } catch (e) { console.warn("[EXTENSION] capture rejected", e.message); }
}

/* ---------------- session goal: is the page the user is reading part of their goal? */
// Checked a short moment after the page opens (quick redirects and tab flicks are skipped), once per page per goal.
// Pages that are not part of the goal get a small warning card on the page; the same site is not warned again for a while.
const GOAL_DELAY_MS = 1200;
const WARN_AGAIN_MS = 10 * 60 * 1000;
let goalTimer = null;
const goalInFlight = new Set();

async function setOffGoal(v) {
  const { offGoal } = await sget("offGoal");
  if (!!offGoal === v) return;
  await sset({ offGoal: v });
  notifyTracking();
}

async function scheduleGoalCheck(tab, s, search) {
  clearTimeout(goalTimer);
  if (!s.goal) return setOffGoal(false);
  const norm = normalizeUrl(tab.url);
  const { goalChecks = {} } = await sget("goalChecks");
  const known = goalChecks[norm];
  if (known) return setOffGoal(!known.on_goal); // already judged: only the badge changes
  await setOffGoal(false);
  goalTimer = setTimeout(() => runGoalCheck(tab.id, norm, search).catch((e) => console.warn("[EXTENSION] goal check failed", e?.message || e)), GOAL_DELAY_MS);
}

// Sites on the workspace's private list (email, chat, social media, payments) are never read or sent anywhere.
// While a goal is set they are still not part of it, so the user gets the same warning, decided here without any request.
async function privateSiteGoal(tab) {
  clearTimeout(goalTimer);
  const s = await state();
  let host = "";
  try { host = new URL(tab?.url || "").hostname.replace(/^www\./, ""); } catch { /* not a web page */ }
  const isPrivate = !!host && isHttp(tab.url) && !tab.incognito && s.tracking && !s.paused && !!s.goal &&
    (s.blocklist || []).some((b) => host === b || host.endsWith("." + b));
  await setOffGoal(isPrivate);
  if (!isPrivate) return;
  const tabId = tab.id, url = tab.url;
  goalTimer = setTimeout(async () => {
    const [now] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (now?.id === tabId && now.url === url) await warnOffGoal(now, s.goal, "This website is not part of your research.", false);
  }, GOAL_DELAY_MS);
}

function extractGoalSnippet() {
  const meta = (sel) => document.querySelector(sel)?.getAttribute("content") || "";
  const root = document.querySelector("article, main, [role=main]") || document.body;
  return { title: document.title, description: meta("meta[name=description]") || meta("meta[property='og:description']"),
    text: (root?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1500) };
}

async function runGoalCheck(tabId, norm, search) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id !== tabId || normalizeUrl(tab.url || "") !== norm || !(await allowed(tab.url, tab))) return; // user moved on
  const s = await state();
  if (!s.goal || goalInFlight.has(norm)) return;
  goalInFlight.add(norm);
  try {
    let page = { title: tab.title || "", description: "", text: "" };
    try { [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractGoalSnippet }); } catch { /* restricted page: title only */ }
    const t0 = Date.now();
    const res = await api("POST", "/goal/check", { workspace_id: s.workspaceId, url: tab.url, title: page?.title || tab.title || "",
      description: page?.description || "", text: page?.text || "", search_query: search?.query || "" });
    if (!res?.checked || !res.check) return;
    console.info("[EXTENSION] goal check", { on_goal: res.check.on_goal, score: res.check.score, cached: res.cached, ms: Date.now() - t0 });
    const { goalChecks = {} } = await sget("goalChecks");
    await sset({ goalChecks: { ...goalChecks, [norm]: { on_goal: res.check.on_goal } } });
    const [now] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const stillHere = now && now.id === tabId && normalizeUrl(now.url || "") === norm;
    if (!stillHere) return;
    await setOffGoal(!res.check.on_goal);
    if (!res.check.on_goal) await warnOffGoal(now, res.goal || s.goal, res.check.reason);
  } finally { goalInFlight.delete(norm); }
}

async function warnOffGoal(tab, goal, reason, canMark = true) {
  let domain = "";
  try { domain = new URL(tab.url).hostname.replace(/^www\./, ""); } catch { return; }
  const { goalWarned = {} } = await sget("goalWarned");
  if (Date.now() - (goalWarned[domain] || 0) < WARN_AGAIN_MS) return; // do not nag on every page of the same site
  await sset({ goalWarned: { ...goalWarned, [domain]: Date.now() } });
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showGoalWarning, args: [goal, reason || "", canMark] });
  } catch {
    // Pages where Chrome does not allow scripts (Web Store, PDF viewer, error pages): use a system notification instead.
    chrome.notifications.create("goal-" + tab.id, { type: "basic", iconUrl: "goal-warning.png", title: "This page is not part of your goal",
      message: `Your goal: ${goal}`.slice(0, 200), priority: 1 });
  }
}

// Runs inside the page (isolated world). The closed shadow root keeps the page's styles away from the card.
function showGoalWarning(goal, reason, canMark) {
  document.getElementById("research-map-goal-warning")?.remove();
  const host = document.createElement("div");
  host.id = "research-map-goal-warning";
  host.style.cssText = "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    .card{box-sizing:border-box;width:350px;max-width:calc(100vw - 32px);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#12151c;
      background:#fff;border-radius:24px;box-shadow:0 2px 6px rgba(18,21,28,.08),0 24px 48px -16px rgba(18,21,28,.35);padding:18px;animation:in .22s ease-out}
    @keyframes in{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:none}}
    .top{display:flex;align-items:center;gap:12px}
    .icon{flex:none;width:40px;height:40px;border-radius:14px;background:#ee7048;display:grid;place-items:center}
    h2{margin:0;flex:1;font-size:15px;font-weight:700;line-height:1.3}
    .x{flex:none;width:28px;height:28px;border:0;border-radius:50%;background:#f5f3f0;font-size:18px;line-height:1;cursor:pointer;color:#666b75}
    .x:hover{background:#e6e2dc}
    .label{margin:14px 0 2px;font-size:12px;font-weight:600;color:#666b75}
    .goal{margin:0;font-weight:600}
    .reason{margin:8px 0 0;color:#2d323c}
    .row{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
    button.b{flex:1;min-width:120px;border:0;border-radius:999px;padding:10px 14px;font:600 13px system-ui,sans-serif;cursor:pointer;transition:transform .15s}
    button.b:hover{transform:translateY(-1px)}
    .primary{background:#12151c;color:#fff}.secondary{background:#f5f3f0;color:#12151c}
  </style>
  <div class="card" role="alertdialog" aria-labelledby="t">
    <div class="top">
      <span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg></span>
      <h2 id="t">This page is not part of your goal</h2>
      <button class="x" aria-label="Close">×</button>
    </div>
    <p class="label">Your goal</p><p class="goal"></p><p class="reason"></p>
    <div class="row"><button class="b primary" data-a="back">Go back</button><button class="b secondary" data-a="related">This page is related</button></div>
  </div>`;
  root.querySelector(".goal").textContent = goal;
  if (!canMark) root.querySelector("[data-a=related]").remove();
  if (reason) root.querySelector(".reason").textContent = reason;
  else root.querySelector(".reason").remove();
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => { host.remove(); document.removeEventListener("keydown", onKey, true); };
  document.addEventListener("keydown", onKey, true);
  root.querySelector(".x").onclick = close;
  root.querySelectorAll("button.b").forEach((b) => (b.onclick = () => {
    chrome.runtime.sendMessage({ type: b.dataset.a === "back" ? "GOAL_LEAVE" : "GOAL_MARK_RELATED", title: document.title });
    close();
  }));
  (document.body || document.documentElement).appendChild(host);
}

// Messages from the warning card. Only code this extension injected can send them (sender.id is checked).
chrome.runtime.onMessage.addListener((msg, sender) => {
  const tab = sender.tab;
  if (sender.id !== chrome.runtime.id || !tab?.id) return;
  if (msg?.type === "GOAL_LEAVE") {
    chrome.tabs.goBack(tab.id).catch(() => chrome.tabs.remove(tab.id).catch(() => {}));
  }
  if (msg?.type === "GOAL_MARK_RELATED") {
    (async () => {
      const s = await state();
      await api("POST", "/goal/mark", { workspace_id: s.workspaceId, url: tab.url, title: msg.title || tab.title || "" });
      const { goalChecks = {} } = await sget("goalChecks");
      await sset({ goalChecks: { ...goalChecks, [normalizeUrl(tab.url)]: { on_goal: true } } });
      await setOffGoal(false);
      console.info("[EXTENSION] page marked as related to the goal");
    })().catch((e) => console.warn("[EXTENSION] could not mark page", e?.message || e));
  }
});

/* ---------------- snapshots (max 2/s allowed by Chrome; we take one every few seconds at most) */
let lastShot = 0;
async function snapshot(tab, pageId) {
  if (Date.now() - lastShot < 3000) return;
  const s = await state();
  pageId = pageId || (s.captured || {})[normalizeUrl(tab.url)];
  if (!pageId || typeof pageId !== "string") return;
  // captureVisibleTab shoots whatever tab is visible in the window. Only keep the image if this page's tab is
  // still the visible, fully loaded tab before and after the shot; otherwise it would show another page.
  const stillVisible = async () => {
    const cur = await chrome.tabs.get(tab.id).catch(() => null);
    return !!cur && cur.active && cur.status === "complete" && normalizeUrl(cur.url || "") === normalizeUrl(tab.url);
  };
  if (!(await stillVisible())) return;
  lastShot = Date.now();
  try {
    const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 55 });
    if (!(await stillVisible())) return;
    const image = await shrink(raw, 560);
    broadcast({ type: "SNAPSHOT", url: normalizeUrl(tab.url), page_id: pageId, image });
    const { lastUpload = {} } = await get("lastUpload");
    if (Date.now() - (lastUpload[pageId] || 0) > 15000) {
      await api("PUT", `/pages/${pageId}/preview`, { image });
      await set({ lastUpload: { ...lastUpload, [pageId]: Date.now() } });
    }
  } catch { /* window not focused or page not capturable */ }
}
async function shrink(dataUrl, width) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const h = Math.round((bmp.height * width) / bmp.width);
  const canvas = new OffscreenCanvas(width, h);
  canvas.getContext("2d").drawImage(bmp, 0, 0, width, h);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return "data:image/jpeg;base64," + btoa(bin);
}

/* ---------------- browser events */
chrome.tabs.onActivated.addListener(() => { checkActiveTab(); sendTabsState(); });
chrome.tabs.onRemoved.addListener((tabId) => { serial(endVisit); serial(() => forgetTab(tabId)); sendTabsState(); });
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // URL change (incl. SPA) or load finished on the visible tab: one coalesced check; same-URL repeats are no-ops.
  if ((info.url || info.status === "complete") && tab.active) checkActiveTab();
  if (info.status === "complete") sendTabsState();
});
const onTopFrameNav = (d) => {
  if (d.frameId !== 0) return;
  serial(() => noteNavigation(d.tabId, d.url));
  checkActiveTab();
};
chrome.webNavigation.onCommitted.addListener(onTopFrameNav);
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => serial(() => noteNewTab(d.tabId, d.sourceTabId)));
// SPA navigations (history.pushState/replaceState: YouTube video → video, Reddit, GitHub, docs sites) do not commit
// a new document and do not always produce a tabs.onUpdated "complete", so they need this event to start a new dwell.
chrome.webNavigation.onHistoryStateUpdated.addListener(onTopFrameNav);
chrome.windows.onFocusChanged.addListener((w) => {
  if (w === chrome.windows.WINDOW_ID_NONE) serial(async () => { await endVisit(); await cancelDwell(); });
  else checkActiveTab();
});
chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((st) => {
  if (st === "active") checkActiveTab();
  else serial(async () => { await endVisit(); await cancelDwell(); });
});

chrome.alarms.get("flush").then((al) => { if (!al) chrome.alarms.create("flush", { periodInMinutes: 0.5 }); });
serial(async () => { const { dwell } = await sget("dwell"); if (dwell) armDwell(dwell.due); }); // resume after a worker restart
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "flush") return;
  await flushVisits();
  await flushOutbox();
  await serial(checkDwell);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && (await allowed(tab.url, tab))) snapshot(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  // Also runs after every reload, so clear the menu items first to avoid duplicates.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "highlight", title: "Save highlight to Research Map", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "add", title: "Add page to Research Map", contexts: ["page"] });
    chrome.contextMenus.create({ id: "live", title: "Show this tab live in Research Map", contexts: ["page"] });
  });
  syncState();
});
chrome.runtime.onStartup.addListener(syncState);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const s = await state();
  if (info.menuItemId === "add") return capturePage(tab.id, "manual");
  if (info.menuItemId === "live") return goLive(tab);
  if (info.menuItemId === "highlight" && s.workspaceId) {
    const quote = (info.selectionText || "").trim();
    const words = quote.split(/\s+/);
    const frag = words.length > 8 ? `${encodeURIComponent(words.slice(0, 4).join(" "))},${encodeURIComponent(words.slice(-4).join(" "))}` : encodeURIComponent(quote);
    if (!s.captured?.[normalizeUrl(tab.url)]) await capturePage(tab.id, "manual");
    api("POST", "/capture/highlight", { url: tab.url, quote, fragment_url: tab.url.split("#")[0] + "#:~:text=" + frag, workspace_id: s.workspaceId }).catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  tab = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (cmd === "add-page" && tab) capturePage(tab.id, "manual");
  if (cmd === "go-live" && tab) goLive(tab);
  if (cmd === "pause") {
    const s = await state();
    await set({ paused: !s.paused });
    if (!s.paused) serial(async () => { await endVisit(); await cancelDwell(); }); else checkActiveTab();
    notifyTracking();
  }
});

// Live video: the shortcut/menu click grants activeTab for this tab, which tabCapture requires.
async function goLive(tab) {
  const { webTabId } = await get("webTabId");
  if (!webTabId) return;
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id, consumerTabId: webTabId });
    broadcast({ type: "LIVE_STREAM_ID", url: normalizeUrl(tab.url), stream_id: streamId });
  } catch (e) { console.warn("live failed", e.message); }
}
