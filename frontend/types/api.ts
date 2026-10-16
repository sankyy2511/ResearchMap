/**
 * API contracts — mirror allaboutourproject.md §12.3, §14, §16 and §17.
 * JSON field names are snake_case exactly as the Go backend will send them.
 * Fields marked "(frontend addition)" are documented in frontend/API_CONTRACT.md.
 */

export type UUID = string;
export type ISODate = string;

/* ---------------------------------------------------------------- errors */

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation_failed"
  | "rate_limited"
  | "ai_unavailable"
  | "network_error"
  | "internal";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}

/* ---------------------------------------------------------------- auth */

export interface User {
  id: UUID;
  email: string;
  name: string;
  avatar_color: string;
  created_at: ISODate;
}

export interface RegisterRequest {
  name: string;
  email: string;
  password: string;
}
export interface LoginRequest {
  email: string;
  password: string;
}
export interface AuthResponse {
  user: User;
  /** session token, sent as "Authorization: Bearer" when the web app and the API are on different addresses */
  token?: string;
}
export interface PendingSignup {
  verification_required: true;
  email: string;
}

export type TokenKind = "extension" | "mcp";
export interface ApiToken {
  id: UUID;
  name: string;
  kind: TokenKind;
  created_at: ISODate;
  last_used_at: ISODate | null;
  revoked_at: ISODate | null;
}
export interface CreatedToken extends ApiToken {
  /** Plain token — shown once. */
  token: string;
}

/* ---------------------------------------------------------------- workspaces */

export type Role = "owner" | "editor" | "viewer";

export interface WorkspaceSettings {
  blocklist: string[];
  branches_enabled: boolean;
  min_dwell_seconds: number;
}

export interface WorkspaceMember {
  user_id: UUID;
  name: string;
  email: string;
  avatar_color: string;
  role: Role;
  joined_at: ISODate;
}

export interface Workspace {
  id: UUID;
  owner_id: UUID;
  title: string;
  description: string;
  settings: WorkspaceSettings;
  created_at: ISODate;
  updated_at: ISODate;
  /* list/summary fields (joined by the backend) */
  node_count: number;
  page_count: number;
  topic_count: number;
  members: WorkspaceMember[];
  my_role: Role;
  last_opened_at: ISODate | null;
  active_session: Session | null;
  /** Activity sparkline: pages captured per day for the last 7 days. */
  activity: number[];
}

export interface CreateWorkspaceRequest {
  title: string;
  description?: string;
}
export interface UpdateWorkspaceRequest {
  title?: string;
  description?: string;
  settings?: Partial<WorkspaceSettings>;
}

/* ---------------------------------------------------------------- branches */

export type BranchKind = "main" | "personal" | "agent";
export interface Branch {
  id: UUID;
  workspace_id: UUID;
  kind: BranchKind;
  owner_id: UUID | null;
  name: string;
  color: string;
  created_at: ISODate;
}
/** `?branch=` values understood by GET /workspaces/:id/graph */
export type BranchView = "main" | "mine" | "main,mine" | "all" | UUID;

export interface BranchCompare {
  a: Branch;
  b: Branch;
  in_both: CompareItem[];
  only_a: CompareItem[];
  only_b: CompareItem[];
  findings_a: CompareItem[];
  findings_b: CompareItem[];
  conflicts: Conflict[];
}
export interface CompareItem {
  node_id: UUID;
  type: NodeType;
  title: string;
  url: string | null;
  added_by: string;
}
export interface MergeRequest {
  node_ids: UUID[];
}
export interface MergeResponse {
  copied_node_ids: UUID[];
  copied_edge_ids: UUID[];
  skipped: number;
}

/* ---------------------------------------------------------------- view state */

export type ViewMode = "graph" | "focus" | "list" | "grid" | "timeline";
export type PanelKind =
  | "node"
  | "edge"
  | "radar"
  | "conflicts"
  | "memory"
  | "branches"
  | "inbox"
  | "activity"
  | null;
export type ColorBy = "topic" | "source" | "importance" | "page_type" | "collaborator" | "branch";

export interface GraphFilters {
  tag_ids: UUID[];
  category_ids: UUID[];
  domains: string[];
  page_types: PageType[];
  collaborator_ids: UUID[];
  show_suggested: boolean;
  show_weak: boolean;
}

export interface ViewState {
  zoom: number;
  x: number;
  y: number;
  selected_node_id: UUID | null;
  selected_edge_id: UUID | null;
  view_mode: ViewMode;
  panel: PanelKind;
  branch: BranchView;
  filters: GraphFilters;
  color_by: ColorBy;
  focus_node_id: UUID | null;
}

/* ---------------------------------------------------------------- sessions */

/** (frontend addition) pause state; spec §12 has Alt+Shift+P pause tracking. */
export type SessionState = "active" | "paused" | "stopped";

export interface Session {
  id: UUID;
  workspace_id: UUID;
  user_id: UUID;
  branch_id: UUID;
  title: string;
  started_at: ISODate;
  ended_at: ISODate | null;
  open_tabs: string[];
  state: SessionState;
  /** Total ms spent paused so far. */
  paused_ms: number;
  paused_at: ISODate | null;
  /* summary */
  pages_captured: number;
  pages_visited: number;
  active_ms: number;
  /* session goal ("" = no goal) */
  goal: string;
  /** The goal in full words, as the AI understood it ("cn" → "computer networks"). */
  goal_meaning: string;
  /** The goal can mean clearly different things: the user is asked to write it in full. */
  goal_unclear: boolean;
  /** Key topics the AI split the goal into; covered once a page about the topic was opened. Empty while the AI works. */
  goal_topics: GoalTopic[];
  /** Time on pages that are part of the goal / not part of it (from checked pages + visits). */
  goal_on_ms: number;
  goal_off_ms: number;
  goal_pages_on: number;
  goal_pages_off: number;
}

export interface GoalTopic {
  name: string;
  covered: boolean;
}

/** One page judged against the session goal (by the AI, by local similarity, or marked by the user). */
export interface GoalCheck {
  url: string;
  domain: string;
  title: string;
  on_goal: boolean;
  score: number;
  reason: string;
  covers: number[];
  source: "ai" | "similarity" | "user";
  checked_at: ISODate;
}

export interface StopSessionRequest {
  open_tabs: string[];
}

/* ---------------------------------------------------------------- capture (§12.3) */

export type Transition = "link" | "typed" | "search_result" | "reload" | "manual" | "other";

export interface CapturePageRequest {
  url: string;
  title: string;
  favicon_url?: string | null;
  meta?: {
    description?: string;
    og_image?: string;
    site_name?: string;
    author?: string;
    published_time?: string;
    lang?: string;
  };
  content_text?: string;
  outgoing_links?: string[];
  opener_url?: string | null;
  search_query?: string | null;
  transition?: Transition;
  tab_id?: number;
  captured_at?: ISODate;
  /** workspace to capture into (the extension knows the tracking workspace) */
  workspace_id?: UUID;
}
export interface CapturePageResponse {
  node_id: UUID;
  page_id: UUID;
  is_new: boolean;
}

export interface CaptureSearchRequest {
  query: string;
  engine: string;
  url: string;
  workspace_id?: UUID;
}
export interface CaptureSearchResponse {
  node_id: UUID;
  is_new: boolean;
}

export interface VisitInput {
  url: string;
  tab_id: number;
  started_at: ISODate;
  ended_at: ISODate;
}
export interface CaptureVisitsRequest {
  session_id: UUID;
  visits: VisitInput[];
}

export interface CaptureHighlightRequest {
  url: string;
  quote: string;
  fragment_url: string;
  workspace_id?: UUID;
}

/* ---------------------------------------------------------------- pages */

export type PageType =
  | "article"
  | "documentation"
  | "research_paper"
  | "video"
  | "forum_discussion"
  | "news"
  | "product_page"
  | "tutorial"
  | "reference"
  | "dataset"
  | "other";

export type AnalysisStatus = "pending" | "done" | "failed" | "skipped";

export interface Claim {
  id: UUID;
  page_id: UUID;
  text: string;
  quote: string;
}

export interface Page {
  id: UUID;
  workspace_id: UUID;
  url: string;
  url_normalized: string;
  domain: string;
  title: string;
  favicon_url: string | null;
  og_image_url: string | null;
  site_name: string | null;
  author: string | null;
  published_at: ISODate | null;
  lang: string | null;
  word_count: number;
  analysis_status: AnalysisStatus;
  is_research: boolean | null;
  is_research_reason: string | null;
  page_type: PageType | null;
  main_concept: string | null;
  summary: string | null;
  topics: string[];
  claims: Claim[];
  questions_answered: string[];
  /** Short text excerpt used by search results (backend: ts_headline). */
  excerpt: string;
  preview_captured_at: ISODate | null;
  /** (frontend addition) whether the extension's embed rule works for this site */
  embeddable: boolean;
  created_at: ISODate;
}

export interface PagePreview {
  page_id: UUID;
  /** Data URL of the latest JPEG snapshot, or null if none exists yet. */
  image: string | null;
  captured_at: ISODate | null;
}

/* ---------------------------------------------------------------- nodes */

export type NodeType = "page" | "question" | "note" | "finding" | "topic";
export type NodeStatus = "active" | "inbox" | "analyzing";
export type CreatedVia = "extension" | "manual" | "ai" | "mcp" | "import";

/** AI pipeline stage for the visual processing states (§14.1). */
export type AiStage =
  | "captured"
  | "analyzing"
  | "understood"
  | "organizing"
  | "connected"
  | "ready"
  | "failed";

export interface WhyOpened {
  opener_node_id?: UUID | null;
  opener_url?: string | null;
  opener_title?: string | null;
  search_query?: string | null;
  transition?: Transition | null;
  note?: string | null;
  opened_at?: ISODate | null;
}

/** Research Memory data per node (Agent 3, §14.4 / F15). */
export interface NodeActivity {
  first_opened_at: ISODate | null;
  last_opened_at: ISODate | null;
  total_ms: number;
  visit_count: number;
  previous_topic: string | null;
  next_topic: string | null;
}

/** Live tab state — comes from the Chrome extension's TABS_STATE message (§13.2), not the REST API. */
export type TabState = "active" | "open" | "closed" | "live";

export interface ResearchNode {
  id: UUID;
  workspace_id: UUID;
  branch_id: UUID;
  type: NodeType;
  page_id: UUID | null;
  parent_id: UUID | null;
  origin_node_id: UUID | null;
  title: string;
  body: string;
  /** Position. Relative to the parent topic when parent_id is set (React Flow convention). */
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  collapsed: boolean;
  category_id: UUID | null;
  importance: 1 | 2 | 3 | null;
  status: NodeStatus;
  position_locked: boolean;
  group_locked: boolean;
  name_locked: boolean;
  why_opened: WhyOpened;
  created_by: UUID | null;
  created_by_name: string | null;
  created_via: CreatedVia;
  version: number;
  created_at: ISODate;
  updated_at: ISODate;
  /* joined */
  tag_ids: UUID[];
  activity: NodeActivity;
  ai_stage: AiStage;
  duplicate_of: UUID | null;
}

export interface CreateNodeRequest {
  workspace_id: UUID;
  type: NodeType;
  title: string;
  body?: string;
  x: number;
  y: number;
  parent_id?: UUID | null;
  page_url?: string;
  source_node_ids?: UUID[];
}

export type UpdateNodeRequest = Partial<
  Pick<
    ResearchNode,
    | "title"
    | "body"
    | "x"
    | "y"
    | "width"
    | "height"
    | "collapsed"
    | "parent_id"
    | "category_id"
    | "importance"
    | "status"
    | "position_locked"
    | "group_locked"
    | "name_locked"
    | "why_opened"
  >
> & { version: number };

export interface NodePositionsRequest {
  positions: { id: UUID; x: number; y: number; parent_id?: UUID | null }[];
}

/* ---------------------------------------------------------------- edges */

export type Relation =
  | "answers"
  | "subtopic_of"
  | "explains"
  | "supports"
  | "contradicts"
  | "example_of"
  | "prerequisite_of"
  | "alternative_to"
  | "same_topic"
  | "source_of"
  | "opened_from"
  | "links_to"
  | "duplicate_of";

export type EdgeOrigin = "ai" | "user" | "navigation" | "link" | "embedding" | "mcp";
export type EdgeState = "suggested" | "accepted" | "rejected";

export interface ResearchEdge {
  id: UUID;
  workspace_id: UUID;
  branch_id: UUID;
  source_id: UUID;
  target_id: UUID;
  relation: Relation;
  label: string | null;
  reason: string | null;
  evidence: string[];
  confidence: number | null;
  origin: EdgeOrigin;
  state: EdgeState;
  locked: boolean;
  created_by: UUID | null;
  created_by_name: string | null;
  decided_by: UUID | null;
  decided_by_name: string | null;
  version: number;
  created_at: ISODate;
  updated_at: ISODate;
}

export interface CreateEdgeRequest {
  workspace_id: UUID;
  source_id: UUID;
  target_id: UUID;
  relation: Relation;
  reason?: string;
}
export interface UpdateEdgeRequest {
  state?: EdgeState;
  relation?: Relation;
  reason?: string;
  label?: string | null;
  version: number;
}

/* ---------------------------------------------------------------- annotations */

export type AnnotationKind = "note" | "highlight" | "comment";
export interface Annotation {
  id: UUID;
  workspace_id: UUID;
  node_id: UUID;
  kind: AnnotationKind;
  body: string;
  quote: string | null;
  fragment_url: string | null;
  parent_id: UUID | null;
  resolved: boolean;
  author_id: UUID;
  author_name: string;
  author_color: string;
  created_at: ISODate;
  updated_at: ISODate;
}
export interface CreateAnnotationRequest {
  kind: AnnotationKind;
  body: string;
  quote?: string;
  fragment_url?: string;
  parent_id?: UUID;
}
export interface UpdateAnnotationRequest {
  body?: string;
  resolved?: boolean;
}

/* ---------------------------------------------------------------- tags & categories */

export interface Tag {
  id: UUID;
  workspace_id: UUID;
  name: string;
  color: string;
}
export interface CreateTagRequest {
  name: string;
  color?: string;
}
export interface SetNodeTagsRequest {
  tag_ids: UUID[];
}

export type CategoryKind = "topic" | "source" | "importance" | "custom";
export interface Category {
  id: UUID;
  workspace_id: UUID;
  kind: CategoryKind;
  name: string;
  color: string;
}
export interface CreateCategoryRequest {
  kind: CategoryKind;
  name: string;
  color: string;
}
/** (frontend addition) PATCH /categories/:id for rename/recolor */
export interface UpdateCategoryRequest {
  name?: string;
  color?: string;
}

/* ---------------------------------------------------------------- graph */

export interface GraphResponse {
  workspace: Workspace;
  branches: Branch[];
  nodes: ResearchNode[];
  edges: ResearchEdge[];
  pages: Page[];
  tags: Tag[];
  categories: Category[];
  annotations: Annotation[];
  view_state: ViewState | null;
}

export interface ReorganizeResponse {
  topics_created: number;
  nodes_moved: number;
  /** Token that can be passed to POST /workspaces/:id/reorganize/undo (frontend addition) */
  undo_token: string | null;
}

/* ---------------------------------------------------------------- radar (F17) */

export type RadarKind = "low_coverage" | "unanswered_question" | "unexplored_concept";
export type RadarItemStatus = "open" | "reviewed" | "ignored";

export interface TopicCoverage {
  topic_id: UUID | null;
  topic_name: string;
  sources: number;
  minutes: number;
  notes: number;
  coverage: number;
  flagged: boolean;
}

export interface RadarItem {
  id: UUID;
  kind: RadarKind;
  topic_id: UUID | null;
  node_id: UUID | null;
  title: string;
  message: string;
  source_count: number;
  avg_sources: number;
  coverage: number | null;
  related_node_ids: UUID[];
  suggested_searches: string[] | null;
  status: RadarItemStatus;
}

export interface RadarResponse {
  eligible: boolean;
  eligibility_message: string | null;
  items: RadarItem[];
  topics: TopicCoverage[];
  computed_at: ISODate;
}
export interface RadarSuggestionsResponse {
  topic_id: UUID;
  suggested_searches: string[];
}
/** (frontend addition) PATCH /radar/:itemId {status} for Review / Ignore */
export interface UpdateRadarItemRequest {
  status: RadarItemStatus;
}

/* ---------------------------------------------------------------- conflicts (F16) */

export type ConflictLabel = "contradict" | "partially_contradict" | "different_context";
export type ConflictStatus = "open" | "kept_both" | "resolved" | "dismissed";

export interface ConflictClaimSide {
  node_id: UUID;
  added_by: string;
  claim: string;
  quote: string;
  ref: number | null;
  title: string;
  url: string;
  fragment_url: string;
}

export interface ConflictAnalysis {
  topic: string;
  claims: [ConflictClaimSide, ConflictClaimSide];
  key_differences: string[];
  possible_reasons: string[];
  context: string;
  how_to_evaluate: string[];
  label: ConflictLabel;
  confidence: number;
}

export interface Conflict {
  id: UUID;
  workspace_id: UUID;
  node_a_id: UUID;
  node_b_id: UUID;
  label: ConflictLabel;
  analysis: ConflictAnalysis;
  confidence: number;
  status: ConflictStatus;
  resolution_note: string | null;
  resolved_by: UUID | null;
  cross_branch: boolean;
  created_at: ISODate;
}
export interface UpdateConflictRequest {
  status: ConflictStatus;
  resolution_note?: string;
}
export interface MethodologyResponse {
  conflict_id: UUID;
  checklist: { source: "a" | "b" | "both"; item: string }[];
}

/* ---------------------------------------------------------------- search (F12) */

export type SearchResultKind = "page" | "note" | "highlight" | "tag" | "topic" | "question" | "finding";
export interface SearchResult {
  id: string;
  kind: SearchResultKind;
  node_id: UUID | null;
  title: string;
  snippet: string;
  url: string | null;
  tag_ids: UUID[];
  score: number;
}
export interface SearchFilters {
  kinds?: SearchResultKind[];
  tag_ids?: UUID[];
  domains?: string[];
  page_types?: PageType[];
}
export interface SearchResponse {
  query: string;
  results: SearchResult[];
  took_ms: number;
}

/* ---------------------------------------------------------------- journey / stats / refs / report */

export interface JourneyItem {
  visit_id: UUID;
  node_id: UUID | null;
  page_id: UUID | null;
  url: string;
  title: string;
  topic_id: UUID | null;
  topic_name: string;
  started_at: ISODate;
  ended_at: ISODate;
  duration_ms: number;
}
export interface JourneyResponse {
  session_id: UUID | null;
  items: JourneyItem[];
}

export interface SessionStats {
  session_id: UUID;
  total_duration_ms: number;
  active_ms: number;
  pages_visited: number;
  sources_count: number;
  time_per_page: { page_id: UUID | null; title: string; ms: number }[];
  time_per_site: { site: string; ms: number }[];
}

export interface Reference {
  ref_number: number;
  page_id: UUID;
  node_id: UUID | null;
  title: string;
  url: string;
  domain: string;
  site_name: string | null;
  author: string | null;
  published_at: ISODate | null;
  first_accessed_at: ISODate;
  added_by: string | null;
}
export type ReferenceFormat = "json" | "md" | "bibtex";
export interface ReferencesResponse {
  session_id: UUID;
  format: ReferenceFormat;
  references: Reference[];
  /** Rendered text when format is md or bibtex. */
  text: string | null;
}

export type ReportStatus = "generating" | "ready" | "failed";
export interface SessionReportContent {
  summary: string;
  key_findings: { text: string; refs: number[]; ai_generated: boolean }[];
}
export interface SessionReport {
  id: UUID;
  workspace_id: UUID;
  session_id: UUID;
  status: ReportStatus;
  model: string;
  content: SessionReportContent | null;
  created_at: ISODate;
}

/* ---------------------------------------------------------------- sharing (F21) */

export interface ShareLink {
  id: UUID;
  workspace_id: UUID;
  role: "editor" | "viewer";
  /** Full join URL (token shown once at creation). */
  url: string;
  expires_at: ISODate | null;
  disabled_at: ISODate | null;
  created_at: ISODate;
}
export interface CreateShareLinkRequest {
  role: "editor" | "viewer";
  expires_in_days?: number | null;
}
export interface JoinResponse {
  workspace_id: UUID;
  role: Role;
}

/* ---------------------------------------------------------------- export (F20) */

export type ExportFormat = "json" | "md" | "csv" | "bookmarks" | "mermaid" | "bibtex";
export interface ExportResponse {
  format: ExportFormat;
  filename: string;
  mime: string;
  content: string;
}
export type ImportFormat = "json" | "bookmarks" | "onetab";
export interface ImportRequest {
  format: ImportFormat;
  content: string;
  workspace_id?: UUID;
  title?: string;
}
export interface ImportResponse {
  workspace_id: UUID;
  nodes_imported: number;
}

/* ---------------------------------------------------------------- websocket (§17.2) */

export interface PresenceUser {
  id: UUID;
  name: string;
  color: string;
  selected_node_id: UUID | null;
}

export interface JobStatus {
  kind: "analyze_page" | "place_page" | "cluster" | "check_conflicts" | "radar" | "report" | "metadata";
  status: "queued" | "running" | "done" | "failed";
  message: string;
  node_id?: UUID | null;
  agent?: 1 | 2 | 3 | null;
}

interface WsBase<T extends string, D> {
  type: T;
  workspace_id: UUID;
  by: UUID | null;
  data: D;
}

export type WsServerMessage =
  | WsBase<"node.created", ResearchNode>
  | WsBase<"mcp.research_started", { workspace: Workspace; created: boolean; topic: string; client: string }>
  | WsBase<"node.updated", ResearchNode>
  | WsBase<"node.deleted", { id: UUID }>
  | WsBase<"edge.created", ResearchEdge>
  | WsBase<"edge.updated", ResearchEdge>
  | WsBase<"edge.deleted", { id: UUID }>
  | WsBase<"annotation.created", Annotation>
  | WsBase<"annotation.updated", Annotation>
  | WsBase<"annotation.deleted", { id: UUID; node_id: UUID }>
  | WsBase<"page.analyzed", Page>
  | WsBase<"page.created", Page>
  | WsBase<"graph.reorganized", { topics: ResearchNode[]; parent_changes: { id: UUID; parent_id: UUID | null; x: number; y: number }[] }>
  | WsBase<"conflict.detected", Conflict>
  | WsBase<"conflict.updated", Conflict>
  | WsBase<"radar.updated", RadarResponse>
  | WsBase<"preview.updated", { page_id: UUID; captured_at: ISODate }>
  | WsBase<"presence", { users: PresenceUser[] }>
  | WsBase<"node.moving", { id: UUID; x: number; y: number }>
  | WsBase<"job.status", JobStatus>
  | WsBase<"session.updated", Session>
  | WsBase<"goal.checked", { session_id: UUID }>
  | WsBase<"tags.updated", Tag[]>
  | WsBase<"categories.updated", Category[]>;

export type WsServerType = WsServerMessage["type"];

export type WsClientMessage =
  | { type: "presence.update"; data: { selected_node_id: UUID | null } }
  | { type: "node.moving"; data: { id: UUID; x: number; y: number } };
