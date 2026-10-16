import type {
  ApiErrorCode,
  Branch,
  NodeActivity,
  ResearchNode,
  Role,
  Workspace,
  WorkspaceMember,
  WsServerMessage,
} from "@/types/api";
import { mockBus } from "./bus";
import { loadDb, scheduleSave, sessionCookie, type DbNode, type DbUser, type DbWorkspace, type MockDb } from "./db";
import { seedDb } from "./seed";

/* ---------------------------------------------------------------- errors */

export class MockHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
export const notFound = (what: string) => new MockHttpError(404, "not_found", `${what} not found`);
export const forbidden = (msg = "You do not have permission to do this") => new MockHttpError(403, "forbidden", msg);
export const badRequest = (msg: string) => new MockHttpError(400, "bad_request", msg);

/* ---------------------------------------------------------------- state */

let db: MockDb | null = null;

export function getDb(): MockDb {
  if (!db) db = loadDb() ?? seedDb();
  return db;
}
export function persist() {
  if (db) scheduleSave(db);
}
export function resetDb() {
  db = seedDb();
  scheduleSave(db);
}

/** Developer controls for demoing error / latency states (Settings → Demo controls). */
export const mockControls = {
  latency: 180,
  offline: false,
  aiOutage: false,
};

/* ---------------------------------------------------------------- auth & permissions */

export function currentUser(): DbUser | null {
  const id = sessionCookie.get();
  if (!id) return null;
  return getDb().users.find((u) => u.id === id) ?? null;
}

export function requireUser(): DbUser {
  const u = currentUser();
  if (!u) throw new MockHttpError(401, "unauthorized", "Please sign in");
  return u;
}

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export function requireWorkspace(workspaceId: string, minRole: Role = "viewer"): { ws: DbWorkspace; user: DbUser; role: Role } {
  const user = requireUser();
  const d = getDb();
  const ws = d.workspaces.find((w) => w.id === workspaceId && !w.deleted_at);
  if (!ws) throw notFound("Workspace");
  const member = d.members.find((m) => m.workspace_id === workspaceId && m.user_id === user.id);
  if (!member) throw forbidden("You are not a member of this workspace");
  if (ROLE_RANK[member.role] < ROLE_RANK[minRole]) {
    throw forbidden(minRole === "owner" ? "Only the owner can do this" : "Viewers cannot make changes");
  }
  return { ws, user, role: member.role };
}

export function requireNode(nodeId: string, minRole: Role = "viewer") {
  const node = getDb().nodes.find((n) => n.id === nodeId && !n.deleted_at);
  if (!node) throw notFound("Node");
  const ctx = requireWorkspace(node.workspace_id, minRole);
  return { node, ...ctx };
}

/* ---------------------------------------------------------------- serializers */

export function userName(id: string | null): string | null {
  if (!id) return null;
  return getDb().users.find((u) => u.id === id)?.name ?? null;
}

export function mainBranch(workspaceId: string): Branch {
  return getDb().branches.find((b) => b.workspace_id === workspaceId && b.kind === "main")!;
}
export function personalBranch(workspaceId: string, userId: string): Branch | undefined {
  return getDb().branches.find((b) => b.workspace_id === workspaceId && b.kind === "personal" && b.owner_id === userId);
}

/** Branch a user writes into: personal branch when branches are enabled and 2+ members, else Main (§F22). */
export function writeBranch(workspaceId: string, userId: string): Branch {
  const d = getDb();
  const ws = d.workspaces.find((w) => w.id === workspaceId)!;
  const memberCount = d.members.filter((m) => m.workspace_id === workspaceId).length;
  if (ws.settings.branches_enabled && memberCount >= 2) {
    return personalBranch(workspaceId, userId) ?? mainBranch(workspaceId);
  }
  return mainBranch(workspaceId);
}

function topicName(nodeId: string | null | undefined): string | null {
  if (!nodeId) return null;
  const n = getDb().nodes.find((x) => x.id === nodeId);
  if (!n?.parent_id) return null;
  return getDb().nodes.find((x) => x.id === n.parent_id)?.title ?? null;
}

export function nodeActivity(node: DbNode): NodeActivity {
  const empty: NodeActivity = {
    first_opened_at: null,
    last_opened_at: null,
    total_ms: 0,
    visit_count: 0,
    previous_topic: null,
    next_topic: null,
  };
  if (!node.page_id) return empty;
  const d = getDb();
  const all = d.visits
    .filter((v) => v.workspace_id === node.workspace_id)
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  const mine = all.filter((v) => v.page_id === node.page_id);
  if (!mine.length) return empty;
  const total = mine.reduce((s, v) => s + (Date.parse(v.ended_at) - Date.parse(v.started_at)), 0);
  const myTopic = topicName(node.id);
  const pageToNode = new Map(d.nodes.filter((n) => n.page_id && !n.deleted_at).map((n) => [n.page_id!, n.id]));
  const firstIdx = all.findIndex((v) => v.id === mine[0]!.id);
  const lastIdx = all.findIndex((v) => v.id === mine[mine.length - 1]!.id);
  let prev: string | null = null;
  for (let i = firstIdx - 1; i >= 0; i--) {
    const t = topicName(pageToNode.get(all[i]!.page_id ?? ""));
    if (t && t !== myTopic) {
      prev = t;
      break;
    }
  }
  let next: string | null = null;
  for (let i = lastIdx + 1; i < all.length; i++) {
    const t = topicName(pageToNode.get(all[i]!.page_id ?? ""));
    if (t && t !== myTopic) {
      next = t;
      break;
    }
  }
  return {
    first_opened_at: mine[0]!.started_at,
    last_opened_at: mine[mine.length - 1]!.ended_at,
    total_ms: total,
    visit_count: mine.length,
    previous_topic: prev,
    next_topic: next,
  };
}

export function serializeNode(node: DbNode): ResearchNode {
  const { deleted_at: _deleted, ...rest } = node;
  void _deleted;
  return {
    ...rest,
    created_by_name: node.created_via === "mcp" ? "AI assistant (MCP)" : userName(node.created_by),
    activity: nodeActivity(node),
  };
}

export function serializeMembers(workspaceId: string): WorkspaceMember[] {
  const d = getDb();
  return d.members
    .filter((m) => m.workspace_id === workspaceId)
    .map((m) => {
      const u = d.users.find((x) => x.id === m.user_id)!;
      return { user_id: u.id, name: u.name, email: u.email, avatar_color: u.avatar_color, role: m.role, joined_at: m.joined_at };
    });
}

export function serializeWorkspace(ws: DbWorkspace, userId: string): Workspace {
  const d = getDb();
  const nodes = d.nodes.filter((n) => n.workspace_id === ws.id && !n.deleted_at);
  const role = d.members.find((m) => m.workspace_id === ws.id && m.user_id === userId)?.role ?? "viewer";
  const active = d.sessions.find((s) => s.workspace_id === ws.id && s.user_id === userId && s.state !== "stopped") ?? null;
  const activity = Array.from({ length: 7 }, (_, i) => {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - (6 - i));
    const dayEnd = dayStart.getTime() + 86400000;
    return nodes.filter((n) => n.type === "page" && Date.parse(n.created_at) >= dayStart.getTime() && Date.parse(n.created_at) < dayEnd).length;
  });
  return {
    id: ws.id,
    owner_id: ws.owner_id,
    title: ws.title,
    description: ws.description,
    settings: ws.settings,
    created_at: ws.created_at,
    updated_at: ws.updated_at,
    node_count: nodes.filter((n) => n.type !== "topic").length,
    page_count: nodes.filter((n) => n.type === "page").length,
    topic_count: nodes.filter((n) => n.type === "topic").length,
    members: serializeMembers(ws.id),
    my_role: role,
    last_opened_at: ws.last_opened[userId] ?? null,
    active_session: active ? { ...active } : null,
    activity,
  };
}

/* ---------------------------------------------------------------- realtime + events */

export function publish(msg: WsServerMessage) {
  mockBus.publish(msg);
}

export function publishNode(type: "node.created" | "node.updated", node: DbNode, by: string | null) {
  publish({ type, workspace_id: node.workspace_id, by, data: serializeNode(node) });
}

export function logEvent(workspaceId: string, userId: string | null, kind: string, payload: Record<string, unknown>) {
  const d = getDb();
  const session = d.sessions.find((s) => s.workspace_id === workspaceId && s.state !== "stopped");
  d.events.push({
    id: d.nextEventId++,
    workspace_id: workspaceId,
    session_id: session?.id ?? null,
    user_id: userId,
    kind,
    payload,
    created_at: new Date().toISOString(),
  });
}

export function touchWorkspace(workspaceId: string) {
  const ws = getDb().workspaces.find((w) => w.id === workspaceId);
  if (ws) ws.updated_at = new Date().toISOString();
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
