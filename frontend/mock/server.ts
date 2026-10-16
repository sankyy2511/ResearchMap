/**
 * Mock REST server. Same method + path + JSON shapes as the Go backend (§17.1).
 * lib/api/client.ts routes here when NEXT_PUBLIC_API_MODE=mock.
 */
import type {
  Annotation,
  Branch,
  BranchCompare,
  CaptureHighlightRequest,
  CapturePageRequest,
  CaptureSearchRequest,
  CaptureVisitsRequest,
  Category,
  CompareItem,
  CreateAnnotationRequest,
  CreateCategoryRequest,
  CreateEdgeRequest,
  CreateNodeRequest,
  CreateShareLinkRequest,
  CreateTagRequest,
  CreateWorkspaceRequest,
  ExportFormat,
  GraphResponse,
  ImportRequest,
  LoginRequest,
  NodePositionsRequest,
  RegisterRequest,
  ReferenceFormat,
  Role,
  Session,
  SessionReport,
  Tag,
  UpdateAnnotationRequest,
  UpdateCategoryRequest,
  UpdateConflictRequest,
  UpdateEdgeRequest,
  UpdateNodeRequest,
  UpdateRadarItemRequest,
  UpdateWorkspaceRequest,
  ViewState,
} from "@/types/api";
import { ApiError } from "@/lib/api/errors";
import type { HttpMethod, Query } from "@/lib/api/client";
import { sizeOf } from "@/lib/graph/layout";
import { domainOf } from "@/lib/utils/format";
import { isHttpUrl, normalizeUrl, textFragmentUrl } from "@/lib/utils/url";
import {
  buildExport,
  buildReportContent,
  computeJourney,
  computeRadar,
  computeReferences,
  computeStats,
  referencesBibtex,
  referencesMarkdown,
  search,
  sessionActiveMs,
} from "./compute";
import {
  badRequest,
  currentUser,
  forbidden,
  getDb,
  logEvent,
  mainBranch,
  MockHttpError,
  mockControls,
  notFound,
  persist,
  publish,
  publishNode,
  requireNode,
  requireUser,
  requireWorkspace,
  serializeMembers,
  serializeNode,
  serializeWorkspace,
  sleep,
  touchWorkspace,
  writeBranch,
} from "./core";
import { mockBus } from "./bus";
import { sessionCookie, uid, type DbNode, type DbPage } from "./db";
import { LIBRARY, BROWSING_SCRIPT, type LibraryPage } from "./data/library";
import { defaultSettings, makeBranches, makeEdge, makeNode, makePage } from "./seed";
import { absPos, radarSuggest, relayoutTopic, reorganize, runPipeline } from "./pipeline";

interface Ctx {
  params: Record<string, string>;
  query: Query;
  body: unknown;
}
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
const routes: { method: HttpMethod; re: RegExp; keys: string[]; handler: Handler }[] = [];
function route(method: HttpMethod, pattern: string, handler: Handler) {
  const keys: string[] = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), "([^/]+)"))}$`);
  routes.push({ method, re, keys, handler });
}
const now = () => new Date().toISOString();

/* ================================================================ auth */

route("POST", "/auth/register", ({ body }) => {
  const { name, email, password } = body as RegisterRequest;
  if (!name?.trim() || !email?.includes("@")) throw new MockHttpError(422, "validation_failed", "Enter your name and a valid email");
  if (!password || password.length < 8) throw new MockHttpError(422, "validation_failed", "Password must be at least 8 characters");
  const d = getDb();
  if (d.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) throw new MockHttpError(409, "conflict", "An account with this email already exists");
  const colors = ["#ee7048", "#f3a283", "#3a7552", "#3d5f88", "#c9544f", "#96601f"];
  const user = { id: uid(), name: name.trim(), email: email.trim().toLowerCase(), password, avatar_color: colors[d.users.length % colors.length]!, created_at: now() };
  d.users.push(user);
  sessionCookie.set(user.id);
  persist();
  const { password: _p, ...pub } = user;
  void _p;
  return { user: pub };
});
route("POST", "/auth/login", ({ body }) => {
  const { email, password } = body as LoginRequest;
  const u = getDb().users.find((x) => x.email.toLowerCase() === (email ?? "").trim().toLowerCase());
  if (!u || u.password !== password) throw new MockHttpError(401, "unauthorized", "Email or password is incorrect");
  sessionCookie.set(u.id);
  const { password: _p, ...pub } = u;
  void _p;
  return { user: pub };
});
route("POST", "/auth/logout", () => {
  sessionCookie.set(null);
  return undefined;
});
route("GET", "/me", () => {
  const { password: _p, ...pub } = requireUser();
  void _p;
  return pub;
});
route("GET", "/tokens", () => {
  const u = requireUser();
  return getDb().tokens.filter((t) => t.user_id === u.id && !t.revoked_at).map(({ user_id: _u, ...t }) => (void _u, t));
});
route("POST", "/tokens", ({ body }) => {
  const u = requireUser();
  const { kind, name } = body as { kind: "extension" | "mcp"; name: string };
  const token = `rm_${kind}_${uid().replace(/-/g, "")}`;
  const t = { id: uid(), user_id: u.id, name, kind, created_at: now(), last_used_at: null, revoked_at: null };
  getDb().tokens.push(t);
  persist();
  const { user_id: _u, ...pub } = t;
  void _u;
  return { ...pub, token };
});
route("DELETE", "/tokens/:id", ({ params }) => {
  const t = getDb().tokens.find((x) => x.id === params.id);
  if (t) t.revoked_at = now();
  persist();
});

/* ================================================================ workspaces */

route("GET", "/workspaces", () => {
  const u = requireUser();
  const d = getDb();
  const ids = new Set(d.members.filter((m) => m.user_id === u.id).map((m) => m.workspace_id));
  return d.workspaces
    .filter((w) => ids.has(w.id) && !w.deleted_at)
    .map((w) => serializeWorkspace(w, u.id))
    .sort((a, b) => (b.last_opened_at ?? b.updated_at).localeCompare(a.last_opened_at ?? a.updated_at));
});
route("POST", "/workspaces", ({ body }) => {
  const u = requireUser();
  const { title, description } = body as CreateWorkspaceRequest;
  if (!title?.trim()) throw new MockHttpError(422, "validation_failed", "Give your workspace a name");
  const d = getDb();
  const ws = { id: uid(), owner_id: u.id, title: title.trim(), description: description?.trim() ?? "", settings: defaultSettings(), created_at: now(), updated_at: now(), deleted_at: null, last_opened: {} };
  d.workspaces.push(ws);
  d.members.push({ workspace_id: ws.id, user_id: u.id, role: "owner", joined_at: now() });
  d.branches.push(...makeBranches(ws.id, [u], now()));
  persist();
  return serializeWorkspace(ws, u.id);
});
route("GET", "/workspaces/:id", ({ params }) => {
  const { ws, user } = requireWorkspace(params.id!);
  return serializeWorkspace(ws, user.id);
});
route("PATCH", "/workspaces/:id", ({ params, body }) => {
  const { ws, user } = requireWorkspace(params.id!, "editor");
  const b = body as UpdateWorkspaceRequest;
  if (b.title !== undefined) {
    if (!b.title.trim()) throw new MockHttpError(422, "validation_failed", "Name cannot be empty");
    ws.title = b.title.trim();
  }
  if (b.description !== undefined) ws.description = b.description;
  if (b.settings) ws.settings = { ...ws.settings, ...b.settings };
  ws.updated_at = now();
  persist();
  return serializeWorkspace(ws, user.id);
});
route("DELETE", "/workspaces/:id", ({ params }) => {
  const { ws } = requireWorkspace(params.id!, "owner");
  ws.deleted_at = now();
  persist();
});

function visibleBranchIds(workspaceId: string, userId: string, view: string): Set<string> {
  const d = getDb();
  const bs = d.branches.filter((b) => b.workspace_id === workspaceId);
  const main = bs.find((b) => b.kind === "main")!;
  const mine = bs.find((b) => b.kind === "personal" && b.owner_id === userId);
  if (view === "all") return new Set(bs.map((b) => b.id));
  if (view === "main") return new Set([main.id]);
  if (view === "mine") return new Set(mine ? [mine.id] : [main.id]);
  const agent = bs.find((b) => b.kind === "agent");
  if (view === "main,mine") return new Set([main.id, ...(mine ? [mine.id] : []), ...(agent ? [agent.id] : [])]);
  return new Set([main.id, view]);
}

route("GET", "/workspaces/:id/graph", ({ params, query }) => {
  const { ws, user } = requireWorkspace(params.id!);
  const d = getDb();
  ws.last_opened[user.id] = now();
  const branchIds = visibleBranchIds(ws.id, user.id, String(query.branch ?? "main,mine"));
  const nodes = d.nodes.filter((n) => n.workspace_id === ws.id && !n.deleted_at && (branchIds.has(n.branch_id) || n.type === "topic"));
  const ids = new Set(nodes.map((n) => n.id));
  const pageIds = new Set(nodes.map((n) => n.page_id));
  persist();
  const res: GraphResponse = {
    workspace: serializeWorkspace(ws, user.id),
    branches: d.branches.filter((b) => b.workspace_id === ws.id),
    nodes: nodes.map(serializeNode),
    edges: d.edges.filter((e) => e.workspace_id === ws.id && ids.has(e.source_id) && ids.has(e.target_id)),
    pages: d.pages.filter((p) => pageIds.has(p.id)).map(({ content_text: _c, ...p }) => (void _c, p)),
    tags: d.tags.filter((t) => t.workspace_id === ws.id),
    categories: d.categories.filter((c) => c.workspace_id === ws.id),
    annotations: d.annotations.filter((a) => a.workspace_id === ws.id && ids.has(a.node_id)),
    view_state: d.viewStates[`${ws.id}:${user.id}`] ?? null,
  };
  return res;
});
route("PUT", "/workspaces/:id/view-state", ({ params, body }) => {
  const { ws, user } = requireWorkspace(params.id!);
  getDb().viewStates[`${ws.id}:${user.id}`] = body as ViewState;
  persist();
});
route("POST", "/workspaces/:id/reorganize", async ({ params }) => {
  const { ws, user } = requireWorkspace(params.id!, "editor");
  const d = getDb();
  const token = uid();
  d.reorganizeUndo[ws.id] = { token, nodes: JSON.parse(JSON.stringify(d.nodes.filter((n) => n.workspace_id === ws.id))) };
  publish({ type: "job.status", workspace_id: ws.id, by: user.id, data: { kind: "cluster", status: "running", message: "Re-organizing topics…" } });
  await sleep(900);
  const r = reorganize(ws.id);
  const topics = d.nodes.filter((n) => n.workspace_id === ws.id && n.type === "topic" && !n.deleted_at);
  publish({
    type: "graph.reorganized", workspace_id: ws.id, by: user.id,
    data: {
      topics: topics.map(serializeNode),
      parent_changes: d.nodes.filter((n) => n.workspace_id === ws.id && !n.deleted_at && n.type !== "topic").map((n) => ({ id: n.id, parent_id: n.parent_id, x: n.x, y: n.y })),
    },
  });
  publish({ type: "job.status", workspace_id: ws.id, by: user.id, data: { kind: "cluster", status: "done", message: `Re-organized · ${r.moved} moved, ${r.created} new topics` } });
  logEvent(ws.id, user.id, "reorganized", r);
  persist();
  return { topics_created: r.created, nodes_moved: r.moved, undo_token: token };
});
route("POST", "/workspaces/:id/reorganize/undo", ({ params, body }) => {
  const { ws, user } = requireWorkspace(params.id!, "editor");
  const d = getDb();
  const snap = d.reorganizeUndo[ws.id];
  if (!snap || snap.token !== (body as { undo_token: string }).undo_token) throw new MockHttpError(409, "conflict", "Nothing to undo");
  d.nodes = [...d.nodes.filter((n) => n.workspace_id !== ws.id), ...snap.nodes];
  delete d.reorganizeUndo[ws.id];
  const nodes = d.nodes.filter((n) => n.workspace_id === ws.id && !n.deleted_at);
  publish({
    type: "graph.reorganized", workspace_id: ws.id, by: user.id,
    data: { topics: nodes.filter((n) => n.type === "topic").map(serializeNode), parent_changes: nodes.filter((n) => n.type !== "topic").map((n) => ({ id: n.id, parent_id: n.parent_id, x: n.x, y: n.y })) },
  });
  persist();
});

/* ================================================================ members / sharing / branches */

route("GET", "/workspaces/:id/members", ({ params }) => {
  requireWorkspace(params.id!);
  return serializeMembers(params.id!);
});
route("GET", "/workspaces/:id/share-links", ({ params }) => {
  requireWorkspace(params.id!, "editor");
  return getDb().shareLinks.filter((l) => l.workspace_id === params.id && !l.disabled_at).map(({ token: _t, ...l }) => (void _t, l));
});
route("POST", "/workspaces/:id/share-links", ({ params, body }) => {
  const { ws } = requireWorkspace(params.id!, "owner");
  const b = body as CreateShareLinkRequest;
  const token = uid().replace(/-/g, "");
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const link = {
    id: uid(), workspace_id: ws.id, role: b.role, token, url: `${origin}/join/${token}`,
    expires_at: b.expires_in_days ? new Date(Date.now() + b.expires_in_days * 86400000).toISOString() : null, disabled_at: null, created_at: now(),
  };
  getDb().shareLinks.push(link);
  persist();
  const { token: _t, ...pub } = link;
  void _t;
  return pub;
});
route("DELETE", "/workspaces/:id/share-links/:linkId", ({ params }) => {
  requireWorkspace(params.id!, "owner");
  const l = getDb().shareLinks.find((x) => x.id === params.linkId);
  if (l) l.disabled_at = now();
  persist();
});
route("POST", "/join/:token", ({ params }) => {
  const u = requireUser();
  const d = getDb();
  const link = d.shareLinks.find((l) => l.token === params.token);
  if (!link || link.disabled_at) throw notFound("Invite link");
  if (link.expires_at && Date.parse(link.expires_at) < Date.now()) throw new MockHttpError(403, "forbidden", "This invite link has expired");
  const existing = d.members.find((m) => m.workspace_id === link.workspace_id && m.user_id === u.id);
  if (!existing) {
    d.members.push({ workspace_id: link.workspace_id, user_id: u.id, role: link.role, joined_at: now() });
    if (!d.branches.some((b) => b.workspace_id === link.workspace_id && b.owner_id === u.id)) {
      d.branches.push({ id: uid(), workspace_id: link.workspace_id, kind: "personal", owner_id: u.id, name: `${u.name.split(" ")[0]}'s branch`, color: u.avatar_color, created_at: now() });
    }
  }
  persist();
  return { workspace_id: link.workspace_id, role: existing?.role ?? link.role };
});
route("PATCH", "/workspaces/:id/members/:userId", ({ params, body }) => {
  requireWorkspace(params.id!, "owner");
  const m = getDb().members.find((x) => x.workspace_id === params.id && x.user_id === params.userId);
  if (!m) throw notFound("Member");
  if (m.role === "owner") throw forbidden("The owner's role cannot be changed");
  m.role = (body as { role: Role }).role;
  persist();
  return serializeMembers(params.id!).find((x) => x.user_id === params.userId);
});
route("DELETE", "/workspaces/:id/members/:userId", ({ params }) => {
  requireWorkspace(params.id!, "owner");
  const d = getDb();
  const m = d.members.find((x) => x.workspace_id === params.id && x.user_id === params.userId);
  if (m?.role === "owner") throw forbidden("The owner cannot be removed");
  d.members = d.members.filter((x) => !(x.workspace_id === params.id && x.user_id === params.userId));
  persist();
});
route("GET", "/workspaces/:id/branches", ({ params }) => {
  requireWorkspace(params.id!);
  return getDb().branches.filter((b) => b.workspace_id === params.id);
});
route("POST", "/workspaces/:id/branches", ({ params, body }) => {
  const { ws, user } = requireWorkspace(params.id!, "editor");
  const b: Branch = { id: uid(), workspace_id: ws.id, kind: "personal", owner_id: user.id, name: (body as { name: string }).name, color: user.avatar_color, created_at: now() };
  getDb().branches.push(b);
  persist();
  return b;
});
route("GET", "/workspaces/:id/branches/compare", ({ params, query }) => {
  requireWorkspace(params.id!);
  const d = getDb();
  const a = d.branches.find((b) => b.id === query.a);
  const b = d.branches.find((x) => x.id === query.b);
  if (!a || !b) throw notFound("Branch");
  const itemsOf = (branchId: string) => d.nodes.filter((n) => n.branch_id === branchId && !n.deleted_at && n.type !== "topic");
  const toItem = (n: DbNode): CompareItem => ({
    node_id: n.id, type: n.type, title: n.title, url: d.pages.find((p) => p.id === n.page_id)?.url ?? null,
    added_by: n.created_via === "mcp" ? "AI assistant (MCP)" : d.users.find((u) => u.id === n.created_by)?.name ?? "Unknown",
  });
  const A = itemsOf(a.id);
  const Bn = itemsOf(b.id);
  const urlOf = (n: DbNode) => d.pages.find((p) => p.id === n.page_id)?.url_normalized;
  const bUrls = new Set(Bn.map(urlOf).filter(Boolean));
  const aUrls = new Set(A.map(urlOf).filter(Boolean));
  const ids = new Set([...A, ...Bn].map((n) => n.id));
  const res: BranchCompare = {
    a, b,
    in_both: A.filter((n) => n.type === "page" && bUrls.has(urlOf(n))).map(toItem),
    only_a: A.filter((n) => n.type === "page" && !bUrls.has(urlOf(n))).map(toItem),
    only_b: Bn.filter((n) => n.type === "page" && !aUrls.has(urlOf(n))).map(toItem),
    findings_a: A.filter((n) => n.type === "finding" || n.type === "note").map(toItem),
    findings_b: Bn.filter((n) => n.type === "finding" || n.type === "note").map(toItem),
    conflicts: d.conflicts.filter((c) => c.workspace_id === params.id && (ids.has(c.node_a_id) || ids.has(c.node_b_id))),
  };
  return res;
});
route("POST", "/branches/:id/merge", ({ params, body }) => {
  const d = getDb();
  const branch = d.branches.find((b) => b.id === params.id);
  if (!branch) throw notFound("Branch");
  const { user } = requireWorkspace(branch.workspace_id, "editor");
  const main = mainBranch(branch.workspace_id);
  const nodeIds = (body as { node_ids: string[] }).node_ids;
  const map = new Map<string, string>();
  let skipped = 0;
  nodeIds.forEach((id) => {
    const src = d.nodes.find((n) => n.id === id && !n.deleted_at);
    if (!src) return void skipped++;
    const already = d.nodes.find((n) => n.origin_node_id === src.id && n.branch_id === main.id && !n.deleted_at);
    if (already) return void (map.set(src.id, already.id), skipped++);
    const pos = absPos(src);
    const copy: DbNode = { ...JSON.parse(JSON.stringify(src)), id: uid(), branch_id: main.id, origin_node_id: src.id, parent_id: null, x: pos.x, y: pos.y + 20, version: 1, created_at: now(), updated_at: now() };
    d.nodes.push(copy);
    map.set(src.id, copy.id);
    publishNode("node.created", copy, user.id);
  });
  const copiedEdges: string[] = [];
  d.edges
    .filter((e) => map.has(e.source_id) || map.has(e.target_id))
    .forEach((e) => {
      const s = map.get(e.source_id) ?? (d.nodes.find((n) => n.id === e.source_id)?.branch_id === main.id ? e.source_id : null);
      const t = map.get(e.target_id) ?? (d.nodes.find((n) => n.id === e.target_id)?.branch_id === main.id ? e.target_id : null);
      if (!s || !t) return;
      const ne = { ...e, id: uid(), branch_id: main.id, source_id: s, target_id: t };
      d.edges.push(ne);
      copiedEdges.push(ne.id);
      publish({ type: "edge.created", workspace_id: branch.workspace_id, by: user.id, data: ne });
    });
  logEvent(branch.workspace_id, user.id, "merged_to_main", { branch_id: branch.id, node_ids: [...map.values()] });
  persist();
  return { copied_node_ids: [...map.values()], copied_edge_ids: copiedEdges, skipped };
});

/* ================================================================ sessions */

function sessionOut(s: Session): Session {
  // The mock has no AI goal checks: sessions keep their goal text only (?? also fills sessions saved before goals existed).
  return { ...s, goal: s.goal ?? "", goal_meaning: s.goal_meaning ?? "", goal_unclear: s.goal_unclear ?? false, goal_topics: s.goal_topics ?? [], goal_on_ms: s.goal_on_ms ?? 0, goal_off_ms: s.goal_off_ms ?? 0,
    goal_pages_on: s.goal_pages_on ?? 0, goal_pages_off: s.goal_pages_off ?? 0, active_ms: sessionActiveMs(s) };
}
function requireSession(id: string, role: Role = "viewer") {
  const s = getDb().sessions.find((x) => x.id === id);
  if (!s) throw notFound("Session");
  const ctx = requireWorkspace(s.workspace_id, role);
  return { s, ...ctx };
}
route("POST", "/workspaces/:id/sessions/start", ({ params, body }) => {
  const { ws, user } = requireWorkspace(params.id!, "editor");
  const d = getDb();
  const active = d.sessions.find((s) => s.workspace_id === ws.id && s.user_id === user.id && s.state !== "stopped");
  const goal = typeof (body as { goal?: unknown } | undefined)?.goal === "string" ? String((body as { goal: string }).goal).trim().slice(0, 500) : undefined;
  if (active) {
    if (goal !== undefined) active.goal = goal;
    persist();
    return sessionOut(active);
  }
  const s: Session = {
    id: uid(), workspace_id: ws.id, user_id: user.id, branch_id: writeBranch(ws.id, user.id).id, title: `Research on ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`,
    started_at: now(), ended_at: null, open_tabs: [], state: "active", paused_ms: 0, paused_at: null, pages_captured: 0, pages_visited: 0, active_ms: 0,
    goal: goal ?? "", goal_meaning: "", goal_unclear: false, goal_topics: [], goal_on_ms: 0, goal_off_ms: 0, goal_pages_on: 0, goal_pages_off: 0,
  };
  d.sessions.push(s);
  logEvent(ws.id, user.id, "session_started", { session_id: s.id });
  publish({ type: "session.updated", workspace_id: ws.id, by: user.id, data: s });
  persist();
  return s;
});
route("POST", "/sessions/:id/stop", ({ params, body }) => {
  const { s, user } = requireSession(params.id!, "editor");
  if (s.state === "paused" && s.paused_at) s.paused_ms += Date.now() - Date.parse(s.paused_at);
  s.state = "stopped";
  s.paused_at = null;
  s.ended_at = now();
  s.open_tabs = (body as { open_tabs?: string[] })?.open_tabs ?? [];
  logEvent(s.workspace_id, user.id, "session_stopped", { session_id: s.id });
  publish({ type: "session.updated", workspace_id: s.workspace_id, by: user.id, data: sessionOut(s) });
  persist();
  return sessionOut(s);
});
route("POST", "/sessions/:id/pause", ({ params }) => {
  const { s, user } = requireSession(params.id!, "editor");
  if (s.state === "active") {
    s.state = "paused";
    s.paused_at = now();
  }
  publish({ type: "session.updated", workspace_id: s.workspace_id, by: user.id, data: sessionOut(s) });
  persist();
  return sessionOut(s);
});
route("POST", "/sessions/:id/resume", ({ params }) => {
  const { s, user } = requireSession(params.id!, "editor");
  if (s.state === "paused") {
    s.paused_ms += Date.now() - Date.parse(s.paused_at ?? now());
    s.paused_at = null;
    s.state = "active";
  }
  publish({ type: "session.updated", workspace_id: s.workspace_id, by: user.id, data: sessionOut(s) });
  persist();
  return sessionOut(s);
});
route("GET", "/workspaces/:id/sessions", ({ params }) => {
  requireWorkspace(params.id!);
  return getDb()
    .sessions.filter((s) => s.workspace_id === params.id)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .map(sessionOut);
});
route("GET", "/sessions/:id/stats", ({ params }) => computeStats(requireSession(params.id!).s));
route("PUT", "/sessions/:id/goal", ({ params, body }) => {
  const { s, user } = requireSession(params.id!, "editor");
  s.goal = String((body as { goal?: string })?.goal ?? "").trim().slice(0, 500);
  s.goal_topics = [];
  publish({ type: "session.updated", workspace_id: s.workspace_id, by: user.id, data: sessionOut(s) });
  persist();
  return sessionOut(s);
});
route("GET", "/sessions/:id/goal-checks", ({ params }) => (requireSession(params.id!), []));
route("GET", "/sessions/:id/references", ({ params, query }) => {
  const { s } = requireSession(params.id!);
  const refs = computeReferences(s.id);
  const format = (query.format ?? "json") as ReferenceFormat;
  return { session_id: s.id, format, references: refs, text: format === "md" ? referencesMarkdown(refs) : format === "bibtex" ? referencesBibtex(refs) : null };
});
route("POST", "/sessions/:id/report", ({ params }) => {
  const { s, user } = requireSession(params.id!, "viewer");
  const d = getDb();
  d.reports = d.reports.filter((r) => r.session_id !== s.id);
  const report: SessionReport = { id: uid(), workspace_id: s.workspace_id, session_id: s.id, status: "generating", model: "openai/gpt-oss-120b (simulated)", content: null, created_at: now() };
  d.reports.push(report);
  publish({ type: "job.status", workspace_id: s.workspace_id, by: user.id, data: { kind: "report", status: "running", message: "Writing session summary…" } });
  setTimeout(() => {
    report.status = mockControls.aiOutage ? "failed" : "ready";
    report.content = mockControls.aiOutage ? null : buildReportContent(s);
    publish({ type: "job.status", workspace_id: s.workspace_id, by: null, data: { kind: "report", status: report.status === "ready" ? "done" : "failed", message: report.status === "ready" ? "Session report ready" : "AI unavailable — statistics still work" } });
    persist();
  }, 2600);
  persist();
  return report;
});
route("GET", "/sessions/:id/report", ({ params }) => {
  const { s } = requireSession(params.id!);
  const r = getDb().reports.find((x) => x.session_id === s.id);
  if (!r) throw notFound("Report");
  return r;
});
route("GET", "/workspaces/:id/journey", ({ params, query }) => {
  requireWorkspace(params.id!);
  const sid = query.session ? String(query.session) : undefined;
  return { session_id: sid ?? null, items: computeJourney(params.id!, sid) };
});

/* ================================================================ capture (extension endpoints) */

function activeSessionFor(workspaceId: string, userId: string) {
  return getDb().sessions.find((s) => s.workspace_id === workspaceId && s.user_id === userId && s.state !== "stopped");
}
function addReference(sessionId: string | undefined, pageId: string, userId: string) {
  if (!sessionId) return;
  const d = getDb();
  if (d.references.some((r) => r.session_id === sessionId && r.page_id === pageId)) return;
  const n = d.references.filter((r) => r.session_id === sessionId).length + 1;
  d.references.push({ session_id: sessionId, page_id: pageId, ref_number: n, first_accessed_at: now(), added_by: userId });
}

route("POST", "/capture/page", ({ body }) => {
  const b = body as CapturePageRequest & { _lib_key?: string; _conflict_with?: string };
  if (!b.workspace_id) throw badRequest("workspace_id is required");
  if (!isHttpUrl(b.url)) throw new MockHttpError(422, "validation_failed", "Only http(s) pages can be captured");
  const { ws, user } = requireWorkspace(b.workspace_id, "editor");
  const d = getDb();
  const domain = domainOf(b.url);
  if (ws.settings.blocklist.some((x) => domain.endsWith(x))) throw forbidden(`${domain} is on the blocklist`);
  const norm = normalizeUrl(b.url);
  const session = activeSessionFor(ws.id, user.id);
  const existingPage = d.pages.find((p) => p.workspace_id === ws.id && p.url_normalized === norm);
  if (existingPage) {
    const existingNode = d.nodes.find((n) => n.page_id === existingPage.id && !n.deleted_at);
    if (existingNode) {
      addReference(session?.id, existingPage.id, user.id);
      persist();
      return { node_id: existingNode.id, page_id: existingPage.id, is_new: false };
    }
  }
  const lib: LibraryPage | undefined =
    [...LIBRARY, ...BROWSING_SCRIPT.flatMap((s) => (s.kind === "page" ? [s.page] : []))].find((l) => l.key === b._lib_key || normalizeUrl(l.url) === norm);
  const page: DbPage = lib
    ? { ...makePage(lib, ws.id, now()), analysis_status: "pending", summary: null, topics: [], claims: [], page_type: null, main_concept: null, is_research: null }
    : {
        ...makePage(
          { key: "", topic: null, url: b.url, title: b.title || domain, site_name: b.meta?.site_name ?? domain, author: b.meta?.author ?? null, published: b.meta?.published_time ?? null, page_type: "article", is_research: true, is_research_reason: "Captured manually", main_concept: b.title, summary: b.meta?.description ?? "", topics: [], claims: [], questions_answered: [], content: b.content_text ?? "", embeddable: false, word_count: (b.content_text ?? "").split(/\s+/).length },
          ws.id, now()),
        analysis_status: "pending", summary: null, topics: [], page_type: null,
      };
  d.pages.push(page);
  // Visits flushed during the dwell time arrived before the page existed — link them now.
  d.visits.forEach((v) => {
    if (!v.page_id && v.workspace_id === ws.id && normalizeUrl(v.url) === norm) v.page_id = page.id;
  });
  const opener = b.opener_url
    ? d.nodes.find((n) => !n.deleted_at && n.workspace_id === ws.id && (d.pages.find((p) => p.id === n.page_id)?.url_normalized === normalizeUrl(b.opener_url!) || (n.type === "question" && b.search_query && n.title.toLowerCase() === b.search_query.toLowerCase())))
    : undefined;
  const tops = d.nodes.filter((n) => n.workspace_id === ws.id && !n.parent_id && !n.deleted_at);
  const occupied = tops.map((n) => ({ x: n.x, y: n.y, w: n.width ?? sizeOf(n.type).w, h: n.height ?? sizeOf(n.type).h }));
  const anchor = opener ? { ...absPos(opener), w: 260, h: 240 } : occupied.length ? { x: Math.min(...occupied.map((o) => o.x)) - 340, y: 0, w: 0, h: 0 } : null;
  const pos = anchor ? { x: anchor.x + (opener ? anchor.w + 60 : 0), y: anchor.y + (opener ? 0 : 400) } : { x: 0, y: 0 };
  const node = makeNode({
    workspace_id: ws.id, branch_id: session?.branch_id ?? writeBranch(ws.id, user.id).id, type: "page", page_id: page.id, title: page.title,
    status: "analyzing", ai_stage: "captured", created_by: user.id, created_via: b.transition === "manual" ? "manual" : "extension", x: pos.x, y: pos.y,
    why_opened: { opener_node_id: opener?.id ?? null, opener_url: b.opener_url ?? null, opener_title: opener ? (opener.type === "question" ? `Search: “${opener.title}”` : opener.title) : null, search_query: b.search_query ?? null, transition: b.transition ?? "link", opened_at: now() },
  });
  d.nodes.push(node);
  addReference(session?.id, page.id, user.id);
  if (session) session.pages_captured += 1;
  logEvent(ws.id, user.id, "node_added", { node_id: node.id, title: node.title });
  touchWorkspace(ws.id);
  publish({ type: "page.created", workspace_id: ws.id, by: user.id, data: (({ content_text: _c, ...p }) => (void _c, p))(page) });
  publishNode("node.created", node, user.id);
  void runPipeline(node.id, lib ?? null, { conflictWithKey: b._conflict_with, byUser: user.id });
  persist();
  return { node_id: node.id, page_id: page.id, is_new: true };
});
route("POST", "/capture/search", ({ body }) => {
  const b = body as CaptureSearchRequest;
  const { ws, user } = requireWorkspace(b.workspace_id!, "editor");
  const d = getDb();
  const existing = d.nodes.find((n) => n.workspace_id === ws.id && n.type === "question" && !n.deleted_at && n.title.toLowerCase() === b.query.toLowerCase());
  if (existing) return { node_id: existing.id, is_new: false };
  const tops = d.nodes.filter((n) => n.workspace_id === ws.id && !n.parent_id && !n.deleted_at);
  const minX = tops.length ? Math.min(...tops.map((n) => n.x)) : 0;
  const q = makeNode({
    workspace_id: ws.id, branch_id: writeBranch(ws.id, user.id).id, type: "question", title: b.query, body: b.engine, created_by: user.id,
    x: minX - 340, y: 420 + d.nodes.filter((n) => n.type === "question" && n.workspace_id === ws.id).length * 140,
    why_opened: { search_query: b.query, opener_url: b.url, transition: "typed", opened_at: now() },
  });
  d.nodes.push(q);
  publishNode("node.created", q, user.id);
  publish({ type: "job.status", workspace_id: ws.id, by: user.id, data: { kind: "metadata", status: "done", message: `Question node from search: “${b.query}”`, node_id: q.id, agent: 3 } });
  persist();
  return { node_id: q.id, is_new: true };
});
route("POST", "/capture/visits", ({ body }) => {
  const b = body as CaptureVisitsRequest;
  const { s, user } = requireSession(b.session_id, "editor");
  const d = getDb();
  let accepted = 0;
  b.visits.forEach((v) => {
    if (Date.parse(v.ended_at) - Date.parse(v.started_at) < 2000) return; // drop tab-switch noise
    const page = d.pages.find((p) => p.workspace_id === s.workspace_id && p.url_normalized === normalizeUrl(v.url));
    // extend last visit if contiguous
    const last = d.visits.filter((x) => x.session_id === s.id).at(-1);
    if (last && last.url === v.url && Date.parse(v.started_at) - Date.parse(last.ended_at) < 3000) last.ended_at = v.ended_at;
    else d.visits.push({ id: uid(), workspace_id: s.workspace_id, session_id: s.id, user_id: user.id, page_id: page?.id ?? null, url: v.url, started_at: v.started_at, ended_at: v.ended_at });
    accepted++;
    const node = page && d.nodes.find((n) => n.page_id === page.id && !n.deleted_at);
    if (node) publishNode("node.updated", node, null);
  });
  s.pages_visited = new Set(d.visits.filter((v) => v.session_id === s.id).map((v) => v.url)).size;
  publish({ type: "session.updated", workspace_id: s.workspace_id, by: null, data: sessionOut(s) });
  persist();
  return { accepted };
});
route("POST", "/capture/highlight", ({ body }) => {
  const b = body as CaptureHighlightRequest;
  const { ws, user } = requireWorkspace(b.workspace_id!, "editor");
  const d = getDb();
  const page = d.pages.find((p) => p.workspace_id === ws.id && p.url_normalized === normalizeUrl(b.url));
  const node = page && d.nodes.find((n) => n.page_id === page.id && !n.deleted_at);
  if (!node) throw notFound("Page node for this URL");
  return createAnnotation(node, user, { kind: "highlight", body: "", quote: b.quote, fragment_url: b.fragment_url });
});
route("PUT", "/pages/:id/preview", ({ params, body }) => {
  const page = getDb().pages.find((p) => p.id === params.id);
  if (!page) throw notFound("Page");
  requireWorkspace(page.workspace_id, "editor");
  const captured_at = now();
  getDb().previews[page.id] = { image: (body as { image: string }).image, captured_at };
  page.preview_captured_at = captured_at;
  publish({ type: "preview.updated", workspace_id: page.workspace_id, by: null, data: { page_id: page.id, captured_at } });
  persist();
  return { page_id: page.id, image: getDb().previews[page.id]!.image, captured_at };
});
route("GET", "/pages/:id/preview", ({ params }) => {
  const page = getDb().pages.find((p) => p.id === params.id);
  if (!page) throw notFound("Page");
  requireWorkspace(page.workspace_id);
  const pv = getDb().previews[page.id];
  return { page_id: page.id, image: pv?.image ?? null, captured_at: pv?.captured_at ?? null };
});

/* ================================================================ nodes */

route("POST", "/nodes", ({ body }) => {
  const b = body as CreateNodeRequest;
  const { ws, user } = requireWorkspace(b.workspace_id, "editor");
  const d = getDb();
  if (!b.title?.trim() && b.type !== "note") throw new MockHttpError(422, "validation_failed", "Title is required");
  const node = makeNode({
    workspace_id: ws.id, branch_id: writeBranch(ws.id, user.id).id, type: b.type, title: b.title?.trim() || "Untitled note", body: b.body ?? "",
    x: b.x, y: b.y, parent_id: b.parent_id ?? null, created_by: user.id, created_via: "manual", position_locked: true, group_locked: !!b.parent_id,
    ...(b.type === "topic" ? { width: 560, height: 320, name_locked: true, body: b.body || "#ee7048" } : {}),
  });
  d.nodes.push(node);
  (b.source_node_ids ?? []).forEach((sid) => {
    const e = makeEdge({ workspace_id: ws.id, branch_id: node.branch_id, source_id: sid, target_id: node.id, relation: "supports", origin: "user", state: "accepted", locked: true, confidence: 1, reason: "Linked by you as supporting evidence.", created_by: user.id, created_by_name: user.name });
    d.edges.push(e);
    publish({ type: "edge.created", workspace_id: ws.id, by: user.id, data: e });
  });
  logEvent(ws.id, user.id, "node_added", { node_id: node.id, type: node.type });
  touchWorkspace(ws.id);
  publishNode("node.created", node, user.id);
  persist();
  return serializeNode(node);
});
route("PATCH", "/nodes/:id", ({ params, body }) => {
  const { node, user } = requireNode(params.id!, "editor");
  const b = body as UpdateNodeRequest;
  if (b.version !== undefined && b.version < node.version - 5) {
    throw new MockHttpError(409, "conflict", `This node was updated by ${node.created_by === user.id ? "another tab" : "a collaborator"}. Showing the latest version.`, serializeNode(node));
  }
  const { version: _v, ...rest } = b;
  void _v;
  const parentChanged = rest.parent_id !== undefined && rest.parent_id !== node.parent_id;
  const oldParent = node.parent_id;
  Object.assign(node, rest);
  if (rest.x !== undefined || rest.y !== undefined) node.position_locked = true;
  if (parentChanged) node.group_locked = true;
  if (rest.title !== undefined && node.type === "topic") node.name_locked = true;
  node.version += 1;
  node.updated_at = now();
  touchWorkspace(node.workspace_id);
  publishNode("node.updated", node, user.id);
  if (node.type === "topic" && rest.collapsed === undefined && rest.title === undefined && rest.body === undefined && (rest.width || rest.height)) {
    /* explicit resize */
  }
  if (parentChanged && oldParent) {
    const t = getDb().nodes.find((n) => n.id === oldParent);
    if (t && getDb().nodes.filter((n) => n.parent_id === t.id && !n.deleted_at).length) {
      /* keep old group layout; user moves win */
    }
  }
  persist();
  return serializeNode(node);
});
route("DELETE", "/nodes/:id", ({ params }) => {
  const { node, user } = requireNode(params.id!, "editor");
  const d = getDb();
  node.deleted_at = now();
  if (node.type === "topic") {
    d.nodes.filter((n) => n.parent_id === node.id && !n.deleted_at).forEach((c) => {
      c.x += node.x;
      c.y += node.y;
      c.parent_id = null;
      c.version += 1;
      publishNode("node.updated", c, user.id);
    });
  }
  publish({ type: "node.deleted", workspace_id: node.workspace_id, by: user.id, data: { id: node.id } });
  logEvent(node.workspace_id, user.id, "node_deleted", { node_id: node.id });
  persist();
});
route("POST", "/nodes/:id/restore", ({ params }) => {
  const d = getDb();
  const node = d.nodes.find((n) => n.id === params.id);
  if (!node) throw notFound("Node");
  const { user } = requireWorkspace(node.workspace_id, "editor");
  node.deleted_at = null;
  node.version += 1;
  publishNode("node.created", node, user.id);
  persist();
  return serializeNode(node);
});
route("POST", "/nodes/positions", ({ body }) => {
  const b = body as NodePositionsRequest;
  const d = getDb();
  b.positions.forEach((p) => {
    const n = d.nodes.find((x) => x.id === p.id);
    if (!n) return;
    const { user } = requireWorkspace(n.workspace_id, "editor");
    n.x = p.x;
    n.y = p.y;
    if (p.parent_id !== undefined && p.parent_id !== n.parent_id) {
      n.parent_id = p.parent_id;
      n.group_locked = true;
    }
    n.position_locked = true;
    n.version += 1;
    publishNode("node.updated", n, user.id);
  });
  persist();
});
route("POST", "/nodes/:id/merge", ({ params, body }) => {
  const { node, user } = requireNode(params.id!, "editor");
  const d = getDb();
  const into = d.nodes.find((n) => n.id === (body as { into_node_id: string }).into_node_id && !n.deleted_at);
  if (!into) throw notFound("Target node");
  d.annotations.filter((a) => a.node_id === node.id).forEach((a) => (a.node_id = into.id));
  into.tag_ids = [...new Set([...into.tag_ids, ...node.tag_ids])];
  d.edges.forEach((e) => {
    if (e.source_id === node.id) e.source_id = into.id;
    if (e.target_id === node.id) e.target_id = into.id;
  });
  d.edges = d.edges.filter((e) => e.source_id !== e.target_id);
  node.deleted_at = now();
  into.duplicate_of = null;
  into.version += 1;
  publish({ type: "node.deleted", workspace_id: node.workspace_id, by: user.id, data: { id: node.id } });
  publishNode("node.updated", into, user.id);
  persist();
  return serializeNode(into);
});

/* ================================================================ edges */

route("POST", "/edges", ({ body }) => {
  const b = body as CreateEdgeRequest;
  const { ws, user } = requireWorkspace(b.workspace_id, "editor");
  if (b.source_id === b.target_id) throw badRequest("A node cannot connect to itself");
  const d = getDb();
  if (d.edges.some((e) => e.source_id === b.source_id && e.target_id === b.target_id && e.relation === b.relation && e.state !== "rejected")) {
    throw new MockHttpError(409, "conflict", "These nodes already have this connection");
  }
  const e = makeEdge({
    workspace_id: ws.id, branch_id: writeBranch(ws.id, user.id).id, source_id: b.source_id, target_id: b.target_id, relation: b.relation,
    origin: "user", state: "accepted", locked: true, confidence: 1, reason: b.reason || "Connected by you.", created_by: user.id, created_by_name: user.name, decided_by: user.id, decided_by_name: user.name,
  });
  d.edges.push(e);
  logEvent(ws.id, user.id, "edge_created", { edge_id: e.id });
  publish({ type: "edge.created", workspace_id: ws.id, by: user.id, data: e });
  persist();
  return e;
});
route("PATCH", "/edges/:id", ({ params, body }) => {
  const d = getDb();
  const e = d.edges.find((x) => x.id === params.id);
  if (!e) throw notFound("Connection");
  const { user } = requireWorkspace(e.workspace_id, "editor");
  const b = body as UpdateEdgeRequest;
  if (b.state) e.state = b.state;
  if (b.relation) {
    e.relation = b.relation;
    if (e.state === "suggested") e.state = "accepted";
  }
  if (b.reason !== undefined) e.reason = b.reason;
  if (b.label !== undefined) e.label = b.label;
  e.locked = true;
  e.decided_by = user.id;
  e.decided_by_name = user.name;
  e.version += 1;
  e.updated_at = now();
  if (e.state === "rejected") d.rejectedPairs.push(`${e.source_id}:${e.target_id}`);
  logEvent(e.workspace_id, user.id, `edge_${e.state}`, { edge_id: e.id });
  publish({ type: "edge.updated", workspace_id: e.workspace_id, by: user.id, data: e });
  persist();
  return e;
});
route("DELETE", "/edges/:id", ({ params }) => {
  const d = getDb();
  const e = d.edges.find((x) => x.id === params.id);
  if (!e) throw notFound("Connection");
  const { user } = requireWorkspace(e.workspace_id, "editor");
  d.edges = d.edges.filter((x) => x.id !== e.id);
  publish({ type: "edge.deleted", workspace_id: e.workspace_id, by: user.id, data: { id: e.id } });
  persist();
});

/* ================================================================ annotations */

function createAnnotation(node: DbNode, user: { id: string; name: string; avatar_color: string }, b: CreateAnnotationRequest): Annotation {
  if (b.kind !== "highlight" && !b.body?.trim()) throw new MockHttpError(422, "validation_failed", "Write something first");
  const page = getDb().pages.find((p) => p.id === node.page_id);
  const a: Annotation = {
    id: uid(), workspace_id: node.workspace_id, node_id: node.id, kind: b.kind, body: b.body ?? "", quote: b.quote ?? null,
    fragment_url: b.fragment_url ?? (b.quote && page ? textFragmentUrl(page.url, b.quote) : null), parent_id: b.parent_id ?? null, resolved: false,
    author_id: user.id, author_name: user.name, author_color: user.avatar_color, created_at: now(), updated_at: now(),
  };
  getDb().annotations.push(a);
  logEvent(node.workspace_id, user.id, `${b.kind}_added`, { node_id: node.id });
  publish({ type: "annotation.created", workspace_id: node.workspace_id, by: user.id, data: a });
  persist();
  return a;
}
route("POST", "/nodes/:id/annotations", ({ params, body }) => {
  const { node, user, role } = requireNode(params.id!, "viewer");
  const b = body as CreateAnnotationRequest;
  if (role === "viewer" && b.kind !== "comment") throw forbidden("Viewers can only comment");
  return createAnnotation(node, user, b);
});
route("PATCH", "/annotations/:id", ({ params, body }) => {
  const a = getDb().annotations.find((x) => x.id === params.id);
  if (!a) throw notFound("Annotation");
  const { user } = requireWorkspace(a.workspace_id, "viewer");
  if (a.author_id !== user.id && (body as UpdateAnnotationRequest).body !== undefined) throw forbidden("You can only edit your own notes");
  Object.assign(a, body as UpdateAnnotationRequest, { updated_at: now() });
  publish({ type: "annotation.updated", workspace_id: a.workspace_id, by: user.id, data: a });
  persist();
  return a;
});
route("DELETE", "/annotations/:id", ({ params }) => {
  const d = getDb();
  const a = d.annotations.find((x) => x.id === params.id);
  if (!a) throw notFound("Annotation");
  const { user } = requireWorkspace(a.workspace_id, "viewer");
  if (a.author_id !== user.id) requireWorkspace(a.workspace_id, "editor");
  d.annotations = d.annotations.filter((x) => x.id !== a.id && x.parent_id !== a.id);
  publish({ type: "annotation.deleted", workspace_id: a.workspace_id, by: user.id, data: { id: a.id, node_id: a.node_id } });
  persist();
});

/* ================================================================ tags & categories */

route("GET", "/workspaces/:id/tags", ({ params }) => (requireWorkspace(params.id!), getDb().tags.filter((t) => t.workspace_id === params.id)));
route("POST", "/workspaces/:id/tags", ({ params, body }) => {
  const { ws, user } = requireWorkspace(params.id!, "editor");
  const b = body as CreateTagRequest;
  const name = b.name?.trim();
  if (!name) throw new MockHttpError(422, "validation_failed", "Tag name is required");
  const d = getDb();
  const existing = d.tags.find((t) => t.workspace_id === ws.id && t.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const colors = ["#ee7048", "#f3a283", "#96601f", "#3a7552", "#3d5f88", "#c9544f"];
  const t: Tag = { id: uid(), workspace_id: ws.id, name, color: b.color ?? colors[d.tags.length % colors.length]! };
  d.tags.push(t);
  publish({ type: "tags.updated", workspace_id: ws.id, by: user.id, data: d.tags.filter((x) => x.workspace_id === ws.id) });
  persist();
  return t;
});
route("PUT", "/nodes/:id/tags", ({ params, body }) => {
  const { node, user } = requireNode(params.id!, "editor");
  node.tag_ids = [...new Set((body as { tag_ids: string[] }).tag_ids)];
  node.version += 1;
  publishNode("node.updated", node, user.id);
  persist();
  return serializeNode(node);
});
route("GET", "/workspaces/:id/categories", ({ params }) => (requireWorkspace(params.id!), getDb().categories.filter((c) => c.workspace_id === params.id)));
route("POST", "/workspaces/:id/categories", ({ params, body }) => {
  const { ws, user } = requireWorkspace(params.id!, "editor");
  const b = body as CreateCategoryRequest;
  if (!b.name?.trim()) throw new MockHttpError(422, "validation_failed", "Category name is required");
  const c: Category = { id: uid(), workspace_id: ws.id, kind: b.kind, name: b.name.trim(), color: b.color };
  getDb().categories.push(c);
  publish({ type: "categories.updated", workspace_id: ws.id, by: user.id, data: getDb().categories.filter((x) => x.workspace_id === ws.id) });
  persist();
  return c;
});
route("PATCH", "/categories/:id", ({ params, body }) => {
  const c = getDb().categories.find((x) => x.id === params.id);
  if (!c) throw notFound("Category");
  const { user } = requireWorkspace(c.workspace_id, "editor");
  Object.assign(c, body as UpdateCategoryRequest);
  publish({ type: "categories.updated", workspace_id: c.workspace_id, by: user.id, data: getDb().categories.filter((x) => x.workspace_id === c.workspace_id) });
  persist();
  return c;
});

/* ================================================================ radar & conflicts */

route("GET", "/workspaces/:id/radar", ({ params }) => (requireWorkspace(params.id!), computeRadar(params.id!)));
route("POST", "/workspaces/:id/radar/:topicId/suggestions", async ({ params }) => {
  requireWorkspace(params.id!);
  if (mockControls.aiOutage) throw new MockHttpError(503, "ai_unavailable", "AI suggestions are unavailable right now");
  await sleep(900);
  const d = getDb();
  const radar = computeRadar(params.id!);
  const item = radar.items.find((i) => i.topic_id === params.topicId || i.id === decodeURIComponent(params.topicId!) || i.node_id === params.topicId);
  const title = item?.title ?? d.nodes.find((n) => n.id === params.topicId)?.title ?? "topic";
  const key = item?.kind === "unexplored_concept" ? item.id : params.topicId!;
  const s = radarSuggest(params.id!, key, title);
  publish({ type: "radar.updated", workspace_id: params.id!, by: null, data: computeRadar(params.id!) });
  return { topic_id: params.topicId!, suggested_searches: s };
});
route("PATCH", "/workspaces/:id/radar/items/:itemId", ({ params, body }) => {
  requireWorkspace(params.id!, "editor");
  const id = decodeURIComponent(params.itemId!);
  getDb().radarStatus[id] = (body as UpdateRadarItemRequest).status;
  persist();
  const radar = computeRadar(params.id!);
  publish({ type: "radar.updated", workspace_id: params.id!, by: null, data: radar });
  return radar.items.find((i) => i.id === id);
});
route("GET", "/workspaces/:id/conflicts", ({ params }) => {
  requireWorkspace(params.id!);
  return getDb().conflicts.filter((c) => c.workspace_id === params.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
});
route("PATCH", "/conflicts/:id", ({ params, body }) => {
  const c = getDb().conflicts.find((x) => x.id === params.id);
  if (!c) throw notFound("Conflict");
  const { user } = requireWorkspace(c.workspace_id, "editor");
  const b = body as UpdateConflictRequest;
  c.status = b.status;
  if (b.resolution_note !== undefined) c.resolution_note = b.resolution_note;
  c.resolved_by = user.id;
  logEvent(c.workspace_id, user.id, "conflict_" + b.status, { conflict_id: c.id });
  publish({ type: "conflict.updated", workspace_id: c.workspace_id, by: user.id, data: c });
  persist();
  return c;
});
route("POST", "/conflicts/:id/methodology", async ({ params }) => {
  const c = getDb().conflicts.find((x) => x.id === params.id);
  if (!c) throw notFound("Conflict");
  requireWorkspace(c.workspace_id);
  if (mockControls.aiOutage) throw new MockHttpError(503, "ai_unavailable", "AI is unavailable right now");
  await sleep(1200);
  return {
    conflict_id: c.id,
    checklist: [
      { source: "a", item: "What dataset was used, and was it curated or collected from routine care?" },
      { source: "a", item: "Who were the comparison readers or baselines, and how many?" },
      { source: "b", item: "Was the model tested on data from sites it was not trained on?" },
      { source: "b", item: "What outcome metric was reported (AUC, sensitivity, harm rating)?" },
      { source: "both", item: "Compare publication dates and model versions." },
      { source: "both", item: "Check funding sources and conflicts of interest." },
    ],
  };
});

/* ================================================================ search / export / import */

route("GET", "/workspaces/:id/search", ({ params, query }) => {
  const { ws, user } = requireWorkspace(params.id!);
  const t0 = performance.now();
  const filters = query.filters ? JSON.parse(String(query.filters)) : {};
  const visible = visibleBranchIds(ws.id, user.id, "all");
  const ids = new Set(getDb().nodes.filter((n) => n.workspace_id === ws.id && visible.has(n.branch_id)).map((n) => n.id));
  const q = String(query.q ?? "");
  return { query: q, results: q.trim() ? search(ws.id, q, filters, ids) : [], took_ms: Math.round(performance.now() - t0) };
});
route("GET", "/workspaces/:id/export", ({ params, query }) => {
  requireWorkspace(params.id!);
  return buildExport(params.id!, (query.format ?? "json") as ExportFormat);
});
route("POST", "/workspaces/import", ({ body }) => {
  const user = requireUser();
  const b = body as ImportRequest;
  const d = getDb();
  let entries: { url: string; title: string }[] = [];
  let title = b.title || "Imported research";
  if (b.format === "json") {
    let parsed: { workspace?: { title?: string }; pages?: { url: string; title: string }[] };
    try {
      parsed = JSON.parse(b.content);
    } catch {
      throw new MockHttpError(422, "validation_failed", "This file is not valid JSON");
    }
    entries = (parsed.pages ?? []).map((p) => ({ url: p.url, title: p.title }));
    title = b.title || `${parsed.workspace?.title ?? "Imported"} (import)`;
  } else if (b.format === "bookmarks") {
    entries = [...b.content.matchAll(/<A[^>]*HREF="([^"]+)"[^>]*>([^<]*)<\/A>/gi)].map((m) => ({ url: m[1]!, title: m[2]! }));
  } else {
    entries = b.content
      .split(/\r?\n/)
      .map((l) => l.split(" | "))
      .filter((p) => p[0] && isHttpUrl(p[0].trim()))
      .map((p) => ({ url: p[0]!.trim(), title: (p[1] ?? p[0]!).trim() }));
  }
  if (!entries.length) throw new MockHttpError(422, "validation_failed", "No links found in this file");
  let wsId = b.workspace_id;
  if (!wsId) {
    const ws = { id: uid(), owner_id: user.id, title, description: `Imported from ${b.format}`, settings: defaultSettings(), created_at: now(), updated_at: now(), deleted_at: null, last_opened: {} };
    d.workspaces.push(ws);
    d.members.push({ workspace_id: ws.id, user_id: user.id, role: "owner", joined_at: now() });
    d.branches.push(...makeBranches(ws.id, [user], now()));
    wsId = ws.id;
  } else requireWorkspace(wsId, "editor");
  const main = mainBranch(wsId);
  entries.slice(0, 200).forEach((e, i) => {
    const lib = LIBRARY.find((l) => normalizeUrl(l.url) === normalizeUrl(e.url));
    const page = makePage(lib ?? { ...LIBRARY[0]!, key: "", url: e.url, title: e.title || domainOf(e.url), site_name: domainOf(e.url), author: null, published: null, summary: "Imported link — not analyzed yet.", topics: [], claims: [], main_concept: e.title, content: "", embeddable: false }, wsId!, now());
    d.pages.push(page);
    d.nodes.push(makeNode({ workspace_id: wsId!, branch_id: main.id, type: "page", page_id: page.id, title: page.title, created_by: user.id, created_via: "import", x: (i % 4) * 300, y: Math.floor(i / 4) * 280 }));
  });
  persist();
  return { workspace_id: wsId, nodes_imported: Math.min(entries.length, 200) };
});

/* ================================================================ dispatcher */

export const mockServer = {
  async handle<T>(method: HttpMethod, path: string, query: Query, body: unknown): Promise<T> {
    await sleep(mockControls.latency * (0.6 + Math.random() * 0.8));
    if (mockControls.offline) throw new ApiError(0, "network_error", "Network request failed");
    const clean = path.split("?")[0]!;
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = clean.match(r.re);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      try {
        const out = await r.handler({ params, query, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
        return (out === undefined ? undefined : JSON.parse(JSON.stringify(out))) as T;
      } catch (e) {
        if (e instanceof MockHttpError) throw new ApiError(e.status, e.code, e.message, e.details);
        if (e instanceof ApiError) throw e;
        console.error("[mock api] unhandled error", method, path, e);
        throw new ApiError(500, "internal", "Something went wrong on the server");
      }
    }
    throw new ApiError(404, "not_found", `No route for ${method} ${clean}`);
  },
};

export { mockBus, currentUser, relayoutTopic };
