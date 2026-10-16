/**
 * In-browser mock database. Shapes follow the PostgreSQL schema in §16 closely so the
 * mock handlers behave like the future Go handlers. Persisted to localStorage.
 */
import type {
  Annotation,
  ApiToken,
  Branch,
  Category,
  Conflict,
  Page,
  RadarItemStatus,
  ResearchEdge,
  ResearchNode,
  Role,
  Session,
  SessionReport,
  ShareLink,
  Tag,
  User,
  ViewState,
  WorkspaceSettings,
} from "@/types/api";

export interface DbUser extends User {
  password: string;
}
export interface DbWorkspace {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  settings: WorkspaceSettings;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  last_opened: Record<string, string>;
}
export interface DbMember {
  workspace_id: string;
  user_id: string;
  role: Role;
  joined_at: string;
}
export type DbNode = Omit<ResearchNode, "activity" | "created_by_name"> & { deleted_at: string | null };
export interface DbPage extends Page {
  content_text: string;
}
export interface DbVisit {
  id: string;
  workspace_id: string;
  session_id: string;
  user_id: string;
  page_id: string | null;
  url: string;
  started_at: string;
  ended_at: string;
}
export interface DbEvent {
  id: number;
  workspace_id: string;
  session_id: string | null;
  user_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
}
export interface DbReference {
  session_id: string;
  page_id: string;
  ref_number: number;
  first_accessed_at: string;
  added_by: string | null;
}
export interface DbShareLink extends ShareLink {
  token: string;
}
export interface DbToken extends ApiToken {
  user_id: string;
}

export interface MockDb {
  version: number;
  users: DbUser[];
  tokens: DbToken[];
  workspaces: DbWorkspace[];
  members: DbMember[];
  shareLinks: DbShareLink[];
  branches: Branch[];
  viewStates: Record<string, ViewState>;
  sessions: Session[];
  pages: DbPage[];
  previews: Record<string, { image: string; captured_at: string }>;
  nodes: DbNode[];
  edges: ResearchEdge[];
  rejectedPairs: string[];
  tags: Tag[];
  categories: Category[];
  annotations: Annotation[];
  visits: DbVisit[];
  events: DbEvent[];
  references: DbReference[];
  conflicts: Conflict[];
  radarStatus: Record<string, RadarItemStatus>;
  radarSuggestions: Record<string, string[]>;
  reports: SessionReport[];
  reorganizeUndo: Record<string, { token: string; nodes: DbNode[] }>;
  nextEventId: number;
}

export const DB_VERSION = 4;
const STORAGE_KEY = "researchmap.mockdb";
const SESSION_KEY = "researchmap.mock.session";

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function emptyDb(): MockDb {
  return {
    version: DB_VERSION,
    users: [],
    tokens: [],
    workspaces: [],
    members: [],
    shareLinks: [],
    branches: [],
    viewStates: {},
    sessions: [],
    pages: [],
    previews: {},
    nodes: [],
    edges: [],
    rejectedPairs: [],
    tags: [],
    categories: [],
    annotations: [],
    visits: [],
    events: [],
    references: [],
    conflicts: [],
    radarStatus: {},
    radarSuggestions: {},
    reports: [],
    reorganizeUndo: {},
    nextEventId: 1,
  };
}

export function loadDb(): MockDb | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MockDb;
    if (parsed.version !== DB_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function scheduleSave(db: MockDb) {
  if (typeof window === "undefined") return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch {
      /* quota exceeded: keep working in memory */
    }
  }, 250);
}

export function clearDbStorage() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(SESSION_KEY);
}

/** Simulates the httpOnly JWT cookie. */
export const sessionCookie = {
  get(): string | null {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  },
  set(userId: string | null) {
    if (typeof window === "undefined") return;
    if (userId) window.localStorage.setItem(SESSION_KEY, userId);
    else window.localStorage.removeItem(SESSION_KEY);
  },
};
