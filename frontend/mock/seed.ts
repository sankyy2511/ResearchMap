/**
 * Seeds the mock DB with the demo workspace "AI in Healthcare" (§22.3):
 * ~20 pages, question/note/finding nodes, topic groups, explained edges,
 * one clear conflict, one under-covered topic, two collaborators, sessions + visits.
 */
import type {
  Annotation,
  Branch,
  Category,
  Conflict,
  NodeType,
  Relation,
  ResearchEdge,
  Session,
  Tag,
  WhyOpened,
} from "@/types/api";
import { packTopic, masonry, TOPIC_PADDING } from "@/lib/graph/layout";
import { normalizeUrl, textFragmentUrl } from "@/lib/utils/url";
import { domainOf } from "@/lib/utils/format";
import { LIBRARY, TOPICS, type LibraryPage, type TopicKey } from "./data/library";
import {
  emptyDb,
  uid,
  type DbMember,
  type DbNode,
  type DbPage,
  type DbReference,
  type DbUser,
  type DbVisit,
  type DbWorkspace,
  type MockDb,
} from "./db";

export const DEMO_EMAIL = "demo@researchmap.app";
export const DEMO_PASSWORD = "demo1234";

const DEFAULT_SETTINGS = {
  blocklist: ["mail.google.com", "outlook.live.com", "web.whatsapp.com", "slack.com", "discord.com", "facebook.com"],
  branches_enabled: true,
  min_dwell_seconds: 5,
};

export function defaultSettings() {
  return { ...DEFAULT_SETTINGS, blocklist: [...DEFAULT_SETTINGS.blocklist] };
}

function at(base: Date, minutes: number): string {
  return new Date(base.getTime() + minutes * 60000).toISOString();
}

export function makePage(lib: LibraryPage, workspaceId: string, createdAt: string): DbPage {
  const id = uid();
  return {
    id,
    workspace_id: workspaceId,
    url: lib.url,
    url_normalized: normalizeUrl(lib.url),
    domain: domainOf(lib.url),
    title: lib.title,
    favicon_url: null,
    og_image_url: null,
    site_name: lib.site_name,
    author: lib.author,
    published_at: lib.published ? new Date(lib.published).toISOString() : null,
    lang: "en",
    word_count: lib.word_count,
    analysis_status: "done",
    is_research: lib.is_research,
    is_research_reason: lib.is_research_reason,
    page_type: lib.page_type,
    main_concept: lib.main_concept,
    summary: lib.summary,
    topics: lib.topics,
    claims: lib.claims.map((c) => ({ id: uid(), page_id: id, text: c.text, quote: c.quote })),
    questions_answered: lib.questions_answered,
    excerpt: lib.content.slice(0, 220),
    preview_captured_at: createdAt,
    embeddable: lib.embeddable,
    created_at: createdAt,
    content_text: lib.content,
  };
}

export function makeNode(
  partial: Partial<DbNode> & { workspace_id: string; branch_id: string; type: NodeType; title: string },
): DbNode {
  const now = partial.created_at ?? new Date().toISOString();
  return {
    id: uid(),
    page_id: null,
    parent_id: null,
    origin_node_id: null,
    body: "",
    x: 0,
    y: 0,
    width: null,
    height: null,
    collapsed: false,
    category_id: null,
    importance: null,
    status: "active",
    position_locked: false,
    group_locked: false,
    name_locked: false,
    why_opened: {},
    created_by: null,
    created_via: "extension",
    version: 1,
    created_at: now,
    updated_at: now,
    tag_ids: [],
    ai_stage: "ready",
    duplicate_of: null,
    deleted_at: null,
    ...partial,
  };
}

export function makeEdge(
  partial: Partial<ResearchEdge> & {
    workspace_id: string;
    branch_id: string;
    source_id: string;
    target_id: string;
    relation: Relation;
  },
): ResearchEdge {
  const now = partial.created_at ?? new Date().toISOString();
  return {
    id: uid(),
    label: null,
    reason: null,
    evidence: [],
    confidence: null,
    origin: "ai",
    state: "suggested",
    locked: false,
    created_by: null,
    created_by_name: null,
    decided_by: null,
    decided_by_name: null,
    version: 1,
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

export function makeBranches(workspaceId: string, members: DbUser[], createdAt: string): Branch[] {
  const branches: Branch[] = [
    { id: uid(), workspace_id: workspaceId, kind: "main", owner_id: null, name: "Main", color: "#12151c", created_at: createdAt },
  ];
  members.forEach((m) =>
    branches.push({
      id: uid(),
      workspace_id: workspaceId,
      kind: "personal",
      owner_id: m.id,
      name: `${m.name.split(" ")[0]}'s branch`,
      color: m.avatar_color,
      created_at: createdAt,
    }),
  );
  branches.push({
    id: uid(),
    workspace_id: workspaceId,
    kind: "agent",
    owner_id: null,
    name: "AI Agent",
    color: "#ee7048",
    created_at: createdAt,
  });
  return branches;
}

export function seedDb(): MockDb {
  const db = emptyDb();
  const now = new Date();
  const created = new Date(now.getTime() - 5 * 86400000).toISOString();

  /* ---------------- users ---------------- */
  const demo: DbUser = {
    id: uid(),
    email: DEMO_EMAIL,
    name: "Demo Researcher",
    avatar_color: "#ee7048",
    created_at: created,
    password: DEMO_PASSWORD,
  };
  const maya: DbUser = {
    id: uid(),
    email: "maya@researchmap.app",
    name: "Maya Iyer",
    avatar_color: "#f3a283",
    created_at: created,
    password: "maya1234",
  };
  const rohan: DbUser = {
    id: uid(),
    email: "rohan@researchmap.app",
    name: "Rohan Das",
    avatar_color: "#3a7552",
    created_at: created,
    password: "rohan1234",
  };
  db.users.push(demo, maya, rohan);

  /* ---------------- workspace ---------------- */
  const ws: DbWorkspace = {
    id: uid(),
    owner_id: demo.id,
    title: "AI in Healthcare",
    description: "Where AI actually helps clinicians today — LLMs, RAG, imaging and regulation.",
    settings: defaultSettings(),
    created_at: created,
    updated_at: new Date(now.getTime() - 3600000).toISOString(),
    deleted_at: null,
    last_opened: { [demo.id]: new Date(now.getTime() - 2 * 3600000).toISOString() },
  };
  db.workspaces.push(ws);
  const members: DbMember[] = [
    { workspace_id: ws.id, user_id: demo.id, role: "owner", joined_at: created },
    { workspace_id: ws.id, user_id: maya.id, role: "editor", joined_at: created },
    { workspace_id: ws.id, user_id: rohan.id, role: "viewer", joined_at: created },
  ];
  db.members.push(...members);
  const branches = makeBranches(ws.id, [demo, maya], created);
  db.branches.push(...branches);
  const main = branches.find((b) => b.kind === "main")!;
  const mayaBranch = branches.find((b) => b.owner_id === maya.id)!;
  const agentBranch = branches.find((b) => b.kind === "agent")!;

  /* ---------------- tags & categories ---------------- */
  const tag = (name: string, color: string): Tag => ({ id: uid(), workspace_id: ws.id, name, color });
  const T = {
    ai: tag("AI", "#ee7048"),
    research: tag("Research", "#3d5f88"),
    important: tag("Important", "#c93535"),
    source: tag("Source", "#96601f"),
    experiment: tag("Experiment", "#3a7552"),
    toread: tag("To read", "#f3a283"),
  };
  db.tags.push(...Object.values(T));
  const cat = (kind: Category["kind"], name: string, color: string): Category => ({ id: uid(), workspace_id: ws.id, kind, name, color });
  const C = {
    peer: cat("source", "Peer-reviewed", "#ee7048"),
    docs: cat("source", "Docs & reference", "#3d5f88"),
    news: cat("source", "News & blogs", "#f3a283"),
    key: cat("importance", "Key evidence", "#c93535"),
  };
  db.categories.push(...Object.values(C));

  /* ---------------- sessions & visit timeline ---------------- */
  const day2 = new Date(now);
  day2.setDate(day2.getDate() - 2);
  day2.setHours(18, 10, 0, 0);
  const day1 = new Date(now);
  day1.setDate(day1.getDate() - 1);
  day1.setHours(8, 40, 0, 0);

  const sPrev: Session = {
    id: uid(),
    workspace_id: ws.id,
    user_id: demo.id,
    branch_id: main.id,
    title: "Evening warm-up: ML basics",
    started_at: at(day2, 0),
    ended_at: at(day2, 42),
    open_tabs: [],
    state: "stopped",
    paused_ms: 0,
    paused_at: null,
    pages_captured: 4,
    pages_visited: 5,
    active_ms: 0,
    goal: "",
    goal_meaning: "",
    goal_unclear: false,
    goal_topics: [],
    goal_on_ms: 0,
    goal_off_ms: 0,
    goal_pages_on: 0,
    goal_pages_off: 0,
  };
  const sMain: Session = {
    id: uid(),
    workspace_id: ws.id,
    user_id: demo.id,
    branch_id: main.id,
    title: "Morning research: RAG & imaging",
    started_at: at(day1, 0),
    ended_at: at(day1, 85),
    open_tabs: ["https://www.nature.com/articles/s41586-019-1799-6", "https://arxiv.org/abs/2005.11401"],
    state: "stopped",
    paused_ms: 0,
    paused_at: null,
    pages_captured: 17,
    pages_visited: 19,
    active_ms: 0,
    goal: "",
    goal_meaning: "",
    goal_unclear: false,
    goal_topics: [],
    goal_on_ms: 0,
    goal_off_ms: 0,
    goal_pages_on: 0,
    goal_pages_off: 0,
  };
  db.sessions.push(sPrev, sMain);

  // [key, session, startMinute, durationMinutes]
  const visitPlan: [string, Session, Date, number, number][] = [
    ["ml-wiki", sPrev, day2, 1, 9],
    ["transformer-wiki", sPrev, day2, 11, 8],
    ["attention", sPrev, day2, 20, 12],
    ["llm-review", sPrev, day2, 33, 7],
    // Morning session — LLM → RAG → Vector DB → LangChain → Imaging → Regulation
    ["medpalm", sMain, day1, 5, 7],
    ["llm-review", sMain, day1, 12, 3],
    ["stat-docs", sMain, day1, 15, 4],
    ["what-is-rag", sMain, day1, 19, 6],
    ["rag-paper", sMain, day1, 25, 5],
    ["hallucination", sMain, day1, 30, 2],
    ["what-is-vectordb", sMain, day1, 32, 5],
    ["pgvector", sMain, day1, 37, 3],
    ["embeddings", sMain, day1, 40, 3],
    ["almanac", sMain, day1, 43, 2],
    ["langchain-rag", sMain, day1, 45, 6],
    ["ai-radiology", sMain, day1, 51, 5],
    ["mammo", sMain, day1, 56, 6],
    ["sensitivity", sMain, day1, 62, 2],
    ["generalization", sMain, day1, 64, 5],
    // idle gap 69 → 74
    ["unet", sMain, day1, 74, 4],
    ["mammo", sMain, day1, 78, 3],
    ["fda-samd", sMain, day1, 81, 2],
  ];

  /* ---------------- pages + page nodes ---------------- */
  const pageByKey = new Map<string, DbPage>();
  const nodeByKey = new Map<string, DbNode>();
  const firstVisit = new Map<string, string>();
  visitPlan.forEach(([key, , base, start]) => {
    if (!firstVisit.has(key)) firstVisit.set(key, at(base, start));
  });

  const nodeCategory: Record<string, string> = {
    medpalm: C.peer.id, "llm-review": C.peer.id, "stat-docs": C.news.id, hallucination: C.peer.id,
    "what-is-rag": C.docs.id, "rag-paper": C.peer.id, almanac: C.peer.id, "langchain-rag": C.docs.id,
    "what-is-vectordb": C.news.id, pgvector: C.docs.id, embeddings: C.news.id,
    "ai-radiology": C.peer.id, mammo: C.key.id, generalization: C.key.id, unet: C.peer.id, sensitivity: C.docs.id,
    "ml-wiki": C.docs.id, "transformer-wiki": C.docs.id, attention: C.peer.id, "fda-samd": C.docs.id,
  };
  const nodeTags: Record<string, Tag[]> = {
    medpalm: [T.ai, T.research, T.important], "llm-review": [T.ai, T.research], "stat-docs": [T.ai],
    hallucination: [T.ai, T.research], "what-is-rag": [T.ai, T.important], "rag-paper": [T.research, T.source],
    almanac: [T.research, T.experiment], "langchain-rag": [T.ai], "what-is-vectordb": [T.ai],
    pgvector: [T.source], embeddings: [T.ai, T.toread], "ai-radiology": [T.research, T.source],
    mammo: [T.research, T.important, T.experiment], generalization: [T.research, T.important],
    unet: [T.research, T.toread], sensitivity: [], "ml-wiki": [T.source], "transformer-wiki": [T.source],
    attention: [T.research, T.source, T.toread], "fda-samd": [T.source],
  };
  const importance: Record<string, 1 | 2 | 3> = { mammo: 3, generalization: 3, medpalm: 3, "what-is-rag": 2, almanac: 2, "fda-samd": 2, "ml-wiki": 1 };

  const opener: Record<string, { key?: string; query?: string; transition: WhyOpened["transition"] }> = {
    medpalm: { key: "llm-review", transition: "link" },
    "what-is-rag": { query: "what is rag", transition: "search_result" },
    "rag-paper": { key: "what-is-rag", transition: "link" },
    hallucination: { query: "llm hallucination rag", transition: "search_result" },
    "what-is-vectordb": { query: "RAG vector database", transition: "search_result" },
    pgvector: { key: "what-is-vectordb", transition: "link" },
    embeddings: { key: "what-is-vectordb", transition: "link" },
    almanac: { key: "hallucination", transition: "link" },
    "langchain-rag": { query: "langchain rag tutorial", transition: "search_result" },
    "ai-radiology": { query: "how is AI used in radiology", transition: "search_result" },
    mammo: { query: "how is AI used in radiology", transition: "search_result" },
    generalization: { key: "mammo", transition: "link" },
    sensitivity: { key: "mammo", transition: "link" },
    unet: { key: "ai-radiology", transition: "link" },
    "fda-samd": { query: "fda ai medical device", transition: "search_result" },
    "transformer-wiki": { key: "ml-wiki", transition: "link" },
    attention: { key: "transformer-wiki", transition: "link" },
  };
  const whyNote: Record<string, string> = {
    "what-is-vectordb": "Opened after researching retrieval architecture.",
    generalization: "Wanted a second opinion on the mammography result.",
  };

  LIBRARY.forEach((lib) => {
    const createdAt = firstVisit.get(lib.key) ?? created;
    const page = makePage(lib, ws.id, createdAt);
    db.pages.push(page);
    pageByKey.set(lib.key, page);
    const node = makeNode({
      workspace_id: ws.id,
      branch_id: main.id,
      type: "page",
      page_id: page.id,
      title: lib.title,
      category_id: nodeCategory[lib.key] ?? null,
      importance: importance[lib.key] ?? null,
      created_by: demo.id,
      created_at: createdAt,
      updated_at: createdAt,
      tag_ids: (nodeTags[lib.key] ?? []).map((t) => t.id),
    });
    nodeByKey.set(lib.key, node);
  });
  // why opened (needs node ids)
  LIBRARY.forEach((lib) => {
    const node = nodeByKey.get(lib.key)!;
    const o = opener[lib.key];
    const openerNode = o?.key ? nodeByKey.get(o.key) : undefined;
    node.why_opened = {
      opener_node_id: openerNode?.id ?? null,
      opener_url: o?.key ? pageByKey.get(o.key)!.url : o?.query ? `https://www.google.com/search?q=${encodeURIComponent(o.query)}` : null,
      opener_title: openerNode?.title ?? (o?.query ? `Google search: "${o.query}"` : null),
      search_query: o?.query ?? null,
      transition: o?.transition ?? "typed",
      note: whyNote[lib.key] ?? null,
      opened_at: firstVisit.get(lib.key) ?? created,
    };
  });

  /* ---------------- question / note / finding nodes ---------------- */
  const qRadiology = makeNode({
    workspace_id: ws.id, branch_id: main.id, type: "question", title: "how is AI used in radiology",
    body: "google", created_by: demo.id, created_at: at(day1, 50),
    why_opened: { search_query: "how is AI used in radiology", transition: "typed", opener_url: "https://www.google.com/search?q=how+is+AI+used+in+radiology" },
  });
  const qRag = makeNode({
    workspace_id: ws.id, branch_id: main.id, type: "question", title: "what is rag", body: "google",
    created_by: demo.id, created_at: at(day1, 18),
    why_opened: { search_query: "what is rag", transition: "typed", opener_url: "https://www.google.com/search?q=what+is+rag" },
  });
  const qPrivacy = makeNode({
    workspace_id: ws.id, branch_id: main.id, type: "question", title: "How is patient data protected in RAG systems?",
    body: "manual", created_via: "manual", created_by: demo.id, created_at: at(day1, 52),
  });
  const noteGoal = makeNode({
    workspace_id: ws.id, branch_id: main.id, type: "note", title: "Research goal", created_via: "manual", created_by: demo.id,
    body: "Understand where AI **actually** helps clinicians today.\n\n- Separate hype from evidence\n- Check external validation\n- Note regulation status",
    created_at: at(day2, 0), importance: 3,
  });
  const findingRag = makeNode({
    workspace_id: ws.id, branch_id: main.id, type: "finding", created_via: "manual", created_by: demo.id,
    title: "Retrieval grounding improves factuality of clinical LLM answers",
    body: "Two independent sources report better factuality when answers are grounded in retrieved documents.",
    created_at: at(day1, 46), tag_ids: [T.important.id],
  });
  const noteImaging = makeNode({
    workspace_id: ws.id, branch_id: main.id, type: "note", title: "Check dataset differences", created_via: "manual", created_by: maya.id,
    body: "The mammography study used a **curated** dataset. The pneumonia study tested on *other hospitals*. Compare before citing.",
    created_at: at(day1, 70),
  });

  /* ---------------- topic groups + layout ---------------- */
  const groupMembers: Record<TopicKey, DbNode[]> = {
    llm: ["medpalm", "llm-review", "stat-docs", "hallucination"].map((k) => nodeByKey.get(k)!),
    rag: [qRag, ...["what-is-rag", "rag-paper", "almanac", "langchain-rag"].map((k) => nodeByKey.get(k)!), findingRag],
    vectordb: ["what-is-vectordb", "pgvector", "embeddings"].map((k) => nodeByKey.get(k)!),
    imaging: [qRadiology, ...["ai-radiology", "mammo", "generalization", "unet", "sensitivity"].map((k) => nodeByKey.get(k)!), noteImaging],
    ml: ["ml-wiki", "transformer-wiki", "attention"].map((k) => nodeByKey.get(k)!),
    regulation: [nodeByKey.get("fda-samd")!],
  };
  const topicNodes: Record<string, DbNode> = {};
  const blocks: { id: string; w: number; h: number }[] = [];
  (Object.keys(groupMembers) as TopicKey[]).forEach((k) => {
    const children = groupMembers[k];
    const packed = packTopic(children.map((c) => ({ id: c.id, type: c.type })));
    const topic = makeNode({
      workspace_id: ws.id, branch_id: main.id, type: "topic", title: TOPICS[k].name, body: TOPICS[k].color,
      width: packed.width, height: packed.height, created_via: "ai", created_at: created,
    });
    topicNodes[k] = topic;
    children.forEach((c) => {
      c.parent_id = topic.id;
      c.x = packed.positions[c.id]!.x;
      c.y = packed.positions[c.id]!.y;
    });
    blocks.push({ id: topic.id, w: packed.width, h: packed.height });
  });
  const placed = masonry(blocks, 3, 90);
  Object.values(topicNodes).forEach((t) => {
    t.x = placed[t.id]!.x + 320;
    t.y = placed[t.id]!.y;
  });
  // loose nodes in a left column
  noteGoal.x = 0;
  noteGoal.y = 0;
  qPrivacy.x = 0;
  qPrivacy.y = 200;

  db.nodes.push(...Object.values(topicNodes), ...nodeByKey.values(), qRadiology, qRag, qPrivacy, noteGoal, findingRag, noteImaging);

  /* ---------------- other branches (Maya + AI Agent) ---------------- */
  const imagingTopic = topicNodes.imaging!;
  const regTopic = topicNodes.regulation!;
  const mayaPageLib: LibraryPage = {
    ...LIBRARY.find((l) => l.key === "ai-radiology")!,
    key: "nhs-ai",
    url: "https://transform.england.nhs.uk/ai-lab/",
    title: "NHS AI Lab: deploying AI in diagnostic imaging",
    site_name: "NHS England",
    author: null,
    published: "2024-11-02",
    page_type: "reference",
    main_concept: "AI deployment in hospitals",
    summary: "Guidance from the NHS AI Lab on piloting and evaluating imaging AI locally before wider rollout.",
    topics: ["Medical imaging", "Deployment", "Regulation"],
    claims: [{ text: "Local evaluation is recommended before deploying imaging AI.", quote: "evaluate performance on local data before deployment" }],
    content: "Trusts should evaluate performance on local data before deployment and monitor it afterwards.",
  };
  const mayaPage = makePage(mayaPageLib, ws.id, at(day1, 72));
  db.pages.push(mayaPage);
  const mayaNode = makeNode({
    workspace_id: ws.id, branch_id: mayaBranch.id, type: "page", page_id: mayaPage.id, title: mayaPage.title,
    created_by: maya.id, created_at: at(day1, 72), x: imagingTopic.x + (imagingTopic.width ?? 0) + 60, y: imagingTopic.y,
    why_opened: { search_query: "nhs ai imaging deployment", transition: "search_result", opened_at: at(day1, 72) },
  });
  const mayaFinding = makeNode({
    workspace_id: ws.id, branch_id: mayaBranch.id, type: "finding", created_by: maya.id, created_via: "manual",
    title: "Imaging AI needs local validation before deployment",
    body: "Both the pneumonia generalization study and NHS guidance point to local evaluation.",
    x: imagingTopic.x + (imagingTopic.width ?? 0) + 60, y: imagingTopic.y + 290, created_at: at(day1, 75),
  });
  const agentLib: LibraryPage = {
    ...LIBRARY.find((l) => l.key === "fda-samd")!,
    key: "who-ethics",
    url: "https://www.who.int/publications/i/item/9789240029200",
    title: "Ethics and governance of artificial intelligence for health",
    site_name: "World Health Organization",
    published: "2021-06-28",
    main_concept: "AI ethics in health",
    summary: "WHO guidance setting six principles for ethical AI in health, including transparency, accountability and inclusiveness.",
    topics: ["Regulation", "Ethics", "Explainability"],
    content: "WHO identifies six principles to ensure AI works for the public interest in all countries.",
  };
  const agentPage = makePage(agentLib, ws.id, new Date(now.getTime() - 6 * 3600000).toISOString());
  db.pages.push(agentPage);
  const agentNode = makeNode({
    workspace_id: ws.id, branch_id: agentBranch.id, type: "page", page_id: agentPage.id, title: agentPage.title,
    created_via: "mcp", x: regTopic.x + (regTopic.width ?? 0) + 60, y: regTopic.y,
    created_at: agentPage.created_at,
    why_opened: { note: "Added by an AI assistant via MCP: \"find a global governance source\"", transition: "other" },
  });
  const agentFinding = makeNode({
    workspace_id: ws.id, branch_id: agentBranch.id, type: "finding", created_via: "mcp",
    title: "Regulators converge on human oversight for clinical AI",
    body: "FDA and WHO sources both stress human oversight and transparency.",
    x: regTopic.x + (regTopic.width ?? 0) + 60, y: regTopic.y + 290, created_at: agentPage.created_at,
  });
  db.nodes.push(mayaNode, mayaFinding, agentNode, agentFinding);

  /* ---------------- edges ---------------- */
  const N = (k: string) => nodeByKey.get(k)!.id;
  const E = (
    source: string,
    target: string,
    relation: Relation,
    confidence: number,
    state: ResearchEdge["state"],
    reason: string,
    evidence: string[],
    origin: ResearchEdge["origin"] = "ai",
    branch = main.id,
  ) =>
    makeEdge({
      workspace_id: ws.id, branch_id: branch, source_id: source, target_id: target, relation, confidence, state, reason, evidence, origin,
      locked: state !== "suggested",
      decided_by: state === "accepted" ? demo.id : null,
      decided_by_name: state === "accepted" ? demo.name : null,
      created_at: at(day1, 60),
    });
  db.edges.push(
    E(qRadiology.id, N("ai-radiology"), "answers", 0.91, "accepted", "The review describes the main ways AI is used in radiology: detection, characterisation and monitoring.", ["Page lists radiology AI use cases", "Opened from this search"]),
    E(qRadiology.id, N("mammo"), "answers", 0.84, "suggested", "A concrete radiology use case (breast cancer screening) with measured results.", ["Mammography is a radiology task", "Opened from this search"]),
    E(qRag.id, N("what-is-rag"), "answers", 0.93, "accepted", "The page defines Retrieval-Augmented Generation directly.", ["Title matches the question", "Defines the concept in the first paragraph"]),
    E(N("rag-paper"), N("what-is-rag"), "source_of", 0.88, "accepted", "The AWS explainer describes the architecture introduced by the original RAG paper.", ["Both describe retriever + generator", "Paper predates the explainer"]),
    E(N("what-is-rag"), N("what-is-vectordb"), "subtopic_of", 0.87, "accepted", "Vector databases are used to store and search embeddings in RAG pipelines.", ["Both mention embeddings and semantic search", "New page describes retrieval step of RAG"]),
    E(N("langchain-rag"), N("what-is-rag"), "example_of", 0.74, "suggested", "The tutorial is a hands-on implementation of the RAG pattern.", ["Tutorial builds retrieve-then-generate pipeline"]),
    E(N("pgvector"), N("what-is-vectordb"), "example_of", 0.81, "suggested", "pgvector is a concrete vector database implementation (inside PostgreSQL).", ["Both discuss HNSW indexes"]),
    E(N("embeddings"), N("what-is-vectordb"), "explains", 0.77, "suggested", "Choosing an embedding model is a prerequisite concept for vector search.", ["Both about semantic search", "Embeddings are what vector DBs store"]),
    E(N("hallucination"), N("what-is-rag"), "supports", 0.79, "accepted", "The survey provides evidence for the claim that retrieval reduces hallucinations.", ["Survey names retrieval augmentation as a mitigation", "Matches claim on RAG page"]),
    E(N("almanac"), N("what-is-rag"), "example_of", 0.82, "accepted", "Almanac applies RAG to clinical medicine.", ["Clinical application of retrieval augmentation"]),
    E(N("almanac"), findingRag.id, "supports", 1, "accepted", "Linked by you as supporting evidence.", [], "user"),
    E(N("hallucination"), findingRag.id, "supports", 1, "accepted", "Linked by you as supporting evidence.", [], "user"),
    E(N("mammo"), N("generalization"), "contradicts", 0.78, "suggested", "One study reports AI outperforming radiologists; the other finds performance drops on external hospital data.", ["Claims about AI vs radiologist accuracy", "Different datasets and settings"]),
    E(N("unet"), N("ai-radiology"), "explains", 0.72, "suggested", "U-Net explains the segmentation technique that many radiology AI tools use.", ["Segmentation is mentioned in both"]),
    E(N("sensitivity"), N("mammo"), "prerequisite_of", 0.69, "suggested", "Understanding sensitivity/specificity is needed to read the screening results.", ["Mammography study reports false positives/negatives"]),
    E(N("attention"), N("transformer-wiki"), "source_of", 0.9, "accepted", "The Wikipedia article summarises the architecture introduced in this paper.", ["Wikipedia cites Vaswani et al."]),
    E(N("transformer-wiki"), N("medpalm"), "prerequisite_of", 0.71, "suggested", "Med-PaLM is built on transformer LLMs.", ["LLMs are transformer models"]),
    E(N("ml-wiki"), N("ai-radiology"), "prerequisite_of", 0.58, "suggested", "General ML background helps with radiology AI concepts.", ["Both discuss deep learning"]),
    E(N("llm-review"), N("stat-docs"), "same_topic", 0.66, "suggested", "Both discuss LLMs for clinical documentation.", ["Clinical documentation topic in both"]),
    E(N("llm-review"), N("medpalm"), "opened_from", 1, "accepted", "Opened from this page (link click).", ["Navigation trail"], "navigation"),
    E(N("hallucination"), N("medpalm"), "explains", 0.62, "suggested", "Hallucination research explains the gaps Med-PaLM's human evaluation found.", ["Both discuss answer safety"]),
    E(N("fda-samd"), N("ai-radiology"), "same_topic", 0.55, "suggested", "Regulation of AI devices applies to radiology AI.", ["Medical devices mentioned"]),
    E(N("langchain-rag"), N("pgvector"), "links_to", 1, "accepted", "The tutorial links to this page.", ["Hyperlink in page"], "link"),
    E(N("embeddings"), N("langchain-rag"), "same_topic", 0.44, "suggested", "Both mention embeddings.", ["Weak overlap"]),
    E(noteImaging.id, N("generalization"), "explains", 1, "accepted", "Note added by Maya.", [], "user"),
    E(mayaNode.id, mayaFinding.id, "supports", 1, "accepted", "Linked by Maya.", [], "user", mayaBranch.id),
    E(agentNode.id, agentFinding.id, "supports", 0.8, "suggested", "Source for the finding (added via MCP).", ["WHO principles include oversight"], "ai", agentBranch.id),
  );
  db.rejectedPairs.push(`${N("pgvector")}:${N("medpalm")}`);

  /* ---------------- conflict ---------------- */
  const mammo = pageByKey.get("mammo")!;
  const gen = pageByKey.get("generalization")!;
  const conflict: Conflict = {
    id: uid(),
    workspace_id: ws.id,
    node_a_id: N("mammo"),
    node_b_id: N("generalization"),
    label: "contradict",
    confidence: 0.78,
    status: "open",
    resolution_note: null,
    resolved_by: null,
    cross_branch: false,
    created_at: at(day1, 69),
    analysis: {
      topic: "Is AI as accurate as radiologists?",
      claims: [
        {
          node_id: N("mammo"), added_by: demo.name, claim: mammo.claims[0]!.text, quote: mammo.claims[0]!.quote, ref: null,
          title: mammo.title, url: mammo.url, fragment_url: textFragmentUrl(mammo.url, mammo.claims[0]!.quote),
        },
        {
          node_id: N("generalization"), added_by: demo.name, claim: gen.claims[0]!.text, quote: gen.claims[0]!.quote, ref: null,
          title: gen.title, url: gen.url, fragment_url: textFragmentUrl(gen.url, gen.claims[0]!.quote),
        },
      ],
      key_differences: [
        "Different tasks: breast cancer screening vs pneumonia detection",
        "Curated research dataset vs data from other hospitals",
        "Reader study vs external validation",
      ],
      possible_reasons: ["Dataset", "Population", "Methodology", "Evaluation conditions", "Timeframe"],
      context:
        "Study A compared the AI with six radiologists on a curated UK/US screening set (2020). Study B tested a chest X-ray model on data from hospitals it was not trained on (2018).",
      how_to_evaluate: ["Check whether each test set came from new hospitals", "Compare sample sizes", "Check who funded each study", "Compare dates and model versions"],
      label: "contradict",
      confidence: 0.78,
    },
  };
  db.conflicts.push(conflict);

  /* ---------------- annotations ---------------- */
  const ann = (a: Partial<Annotation> & { node_id: string; kind: Annotation["kind"]; author: DbUser; minutes: number }): Annotation => {
    const { author, minutes, ...rest } = a;
    return {
      id: uid(), workspace_id: ws.id, body: "", quote: null, fragment_url: null, parent_id: null, resolved: false,
      author_id: author.id, author_name: author.name, author_color: author.avatar_color,
      created_at: at(day1, minutes), updated_at: at(day1, minutes), ...rest,
    };
  };
  const comment = ann({ node_id: N("mammo"), kind: "comment", author: maya, minutes: 71, body: "Their reader study used a curated dataset — worth noting in the report." });
  db.annotations.push(
    ann({ node_id: N("what-is-rag"), kind: "note", author: demo, minutes: 24, body: "**Key idea:** retrieve first, then generate.\n\n- Good intro for the report\n- Compare with Almanac results" }),
    ann({ node_id: N("mammo"), kind: "highlight", author: demo, minutes: 58, quote: mammo.claims[0]!.quote, fragment_url: textFragmentUrl(mammo.url, mammo.claims[0]!.quote) }),
    ann({ node_id: N("generalization"), kind: "highlight", author: demo, minutes: 66, quote: gen.claims[0]!.quote, fragment_url: textFragmentUrl(gen.url, gen.claims[0]!.quote) }),
    comment,
    ann({ node_id: N("mammo"), kind: "comment", author: demo, minutes: 79, parent_id: comment.id, body: "Agreed — I'll put both sides in the conflict view." }),
    ann({ node_id: N("fda-samd"), kind: "note", author: demo, minutes: 83, body: "Only one regulation source so far. Need **EU** and **India** too." }),
    ann({ node_id: N("medpalm"), kind: "highlight", author: demo, minutes: 9, quote: pageByKey.get("medpalm")!.claims[0]!.quote, fragment_url: textFragmentUrl(pageByKey.get("medpalm")!.url, pageByKey.get("medpalm")!.claims[0]!.quote) }),
  );

  /* ---------------- visits + references ---------------- */
  const refCounters = new Map<string, number>();
  visitPlan.forEach(([key, session, base, start, dur]) => {
    const page = pageByKey.get(key)!;
    // split long visits into 2 segments (tab switching)
    const segs = dur > 5 ? [[start, start + dur / 2 - 0.3], [start + dur / 2, start + dur]] : [[start, start + dur]];
    segs.forEach(([s, e]) => {
      const v: DbVisit = {
        id: uid(), workspace_id: ws.id, session_id: session.id, user_id: demo.id, page_id: page.id, url: page.url,
        started_at: at(base, s!), ended_at: at(base, e!),
      };
      db.visits.push(v);
    });
    const refKey = `${session.id}:${page.id}`;
    if (!db.references.some((r) => `${r.session_id}:${r.page_id}` === refKey)) {
      const n = (refCounters.get(session.id) ?? 0) + 1;
      refCounters.set(session.id, n);
      const ref: DbReference = { session_id: session.id, page_id: page.id, ref_number: n, first_accessed_at: at(base, start), added_by: demo.id };
      db.references.push(ref);
    }
  });
  // conflict ref numbers from the main session
  conflict.analysis.claims.forEach((c) => {
    const node = db.nodes.find((n) => n.id === c.node_id)!;
    c.ref = db.references.find((r) => r.session_id === sMain.id && r.page_id === node.page_id)?.ref_number ?? null;
  });

  /* ---------------- events (research memory log) ---------------- */
  db.nodes.forEach((n) => {
    if (n.type === "topic") return;
    db.events.push({
      id: db.nextEventId++, workspace_id: ws.id, session_id: n.created_at >= sMain.started_at ? sMain.id : sPrev.id,
      user_id: n.created_by, kind: "node_added", payload: { node_id: n.id, title: n.title, type: n.type }, created_at: n.created_at,
    });
  });

  /* ---------------- secondary workspaces ---------------- */
  seedSmallWorkspace(db, demo, now);
  const empty: DbWorkspace = {
    id: uid(), owner_id: demo.id, title: "Quantum Computing Basics", description: "Fresh workspace — start tracking to fill it.",
    settings: defaultSettings(), created_at: new Date(now.getTime() - 86400000).toISOString(),
    updated_at: new Date(now.getTime() - 86400000).toISOString(), deleted_at: null, last_opened: {},
  };
  db.workspaces.push(empty);
  db.members.push({ workspace_id: empty.id, user_id: demo.id, role: "owner", joined_at: empty.created_at });
  db.branches.push(...makeBranches(empty.id, [demo], empty.created_at));

  return db;
}

function seedSmallWorkspace(db: MockDb, owner: DbUser, now: Date) {
  const created = new Date(now.getTime() - 9 * 86400000).toISOString();
  const ws: DbWorkspace = {
    id: uid(), owner_id: owner.id, title: "Battery Storage for Solar", description: "Home battery options, chemistry and costs.",
    settings: defaultSettings(), created_at: created, updated_at: new Date(now.getTime() - 4 * 86400000).toISOString(),
    deleted_at: null, last_opened: { [owner.id]: new Date(now.getTime() - 4 * 86400000).toISOString() },
  };
  db.workspaces.push(ws);
  db.members.push({ workspace_id: ws.id, user_id: owner.id, role: "owner", joined_at: created });
  const branches = makeBranches(ws.id, [owner], created);
  db.branches.push(...branches);
  const main = branches[0]!;
  const libs: LibraryPage[] = [
    { ...LIBRARY[0]!, key: "lfp", topic: null, url: "https://en.wikipedia.org/wiki/Lithium_iron_phosphate_battery", title: "Lithium iron phosphate battery — Wikipedia", site_name: "Wikipedia", author: null, published: null, page_type: "reference", main_concept: "LFP batteries", summary: "Overview of LFP chemistry: safer, longer cycle life, lower energy density.", topics: ["LFP", "Battery chemistry"], claims: [], questions_answered: [], content: "LFP batteries have a long cycle life and good thermal stability.", embeddable: true },
    { ...LIBRARY[0]!, key: "nrel", topic: null, url: "https://www.nrel.gov/grid/solar-plus-storage.html", title: "Solar-plus-storage analysis", site_name: "NREL", author: null, published: "2024-01-10", page_type: "reference", main_concept: "Solar + storage", summary: "NREL analysis of pairing batteries with residential solar.", topics: ["Solar", "Storage economics"], claims: [], questions_answered: [], content: "Pairing storage with solar can increase self-consumption.", embeddable: false },
    { ...LIBRARY[0]!, key: "costs", topic: null, url: "https://www.energysage.com/energy-storage/cost-of-solar-batteries/", title: "How much does a solar battery cost?", site_name: "EnergySage", author: null, published: "2025-03-01", page_type: "article", main_concept: "Battery cost", summary: "Consumer guide to installed battery prices and incentives.", topics: ["Storage economics"], claims: [], questions_answered: [], content: "Installed costs vary by capacity and region.", embeddable: false },
  ];
  const children: DbNode[] = [];
  libs.forEach((lib) => {
    const page = makePage(lib, ws.id, created);
    db.pages.push(page);
    children.push(makeNode({ workspace_id: ws.id, branch_id: main.id, type: "page", page_id: page.id, title: page.title, created_by: owner.id, created_at: created }));
  });
  const packed = packTopic(children.map((c) => ({ id: c.id, type: c.type })));
  const topic = makeNode({ workspace_id: ws.id, branch_id: main.id, type: "topic", title: "Home Battery Options", body: "#3a7552", width: packed.width, height: packed.height, created_via: "ai", x: 0, y: TOPIC_PADDING.top });
  children.forEach((c) => {
    c.parent_id = topic.id;
    c.x = packed.positions[c.id]!.x;
    c.y = packed.positions[c.id]!.y;
  });
  db.nodes.push(topic, ...children);
  db.edges.push(
    makeEdge({ workspace_id: ws.id, branch_id: main.id, source_id: children[0]!.id, target_id: children[1]!.id, relation: "explains", confidence: 0.76, reason: "Battery chemistry affects solar-plus-storage performance.", evidence: ["Both discuss cycle life"] }),
  );
}
