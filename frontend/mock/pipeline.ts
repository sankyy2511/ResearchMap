/**
 * Simulated AI pipeline (§14.1): Agent 1 (understand) → Agent 2 (relationships + placement)
 * → Agent 3 (metadata / research memory). Emits the same WebSocket events the Go workers will.
 */
import type { AiStage, JobStatus, Relation } from "@/types/api";
import { packTopic, placeNear, sizeOf } from "@/lib/graph/layout";
import { textFragmentUrl } from "@/lib/utils/url";
import { computeRadar, suggestSearches } from "./compute";
import { getDb, mockControls, persist, publish, publishNode, serializeNode, userName } from "./core";
import type { DbNode } from "./db";
import { makeEdge, makeNode } from "./seed";
import { TOPICS, type LibraryPage } from "./data/library";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function job(workspaceId: string, data: JobStatus) {
  publish({ type: "job.status", workspace_id: workspaceId, by: null, data });
}

function setStage(node: DbNode, stage: AiStage) {
  node.ai_stage = stage;
  node.updated_at = new Date().toISOString();
  node.version += 1;
  publishNode("node.updated", node, null);
}

/** Absolute position of a node (children are relative to their topic). */
export function absPos(n: DbNode) {
  const parent = n.parent_id ? getDb().nodes.find((p) => p.id === n.parent_id) : undefined;
  return parent ? { x: parent.x + n.x, y: parent.y + n.y } : { x: n.x, y: n.y };
}

export function relayoutTopic(topic: DbNode) {
  const d = getDb();
  const children = d.nodes.filter((n) => n.parent_id === topic.id && !n.deleted_at);
  const packed = packTopic(children.map((c) => ({ id: c.id, type: c.type })));
  children.forEach((c) => {
    if (c.position_locked) return;
    c.x = packed.positions[c.id]!.x;
    c.y = packed.positions[c.id]!.y;
    c.version += 1;
  });
  topic.width = packed.width;
  topic.height = packed.height;
  topic.version += 1;
  return children;
}

export async function runPipeline(nodeId: string, lib: LibraryPage | null, opts: { conflictWithKey?: string; byUser: string }) {
  const d = getDb();
  const node = d.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const ws = node.workspace_id;
  const page = d.pages.find((p) => p.id === node.page_id);

  job(ws, { kind: "metadata", status: "done", message: `Agent 3 · Saved metadata for “${node.title}”`, node_id: node.id, agent: 3 });
  await wait(900);
  setStage(node, "analyzing");
  job(ws, { kind: "analyze_page", status: "running", message: "Agent 1 · Analyzing page…", node_id: node.id, agent: 1 });
  await wait(1300);

  if (mockControls.aiOutage) {
    setStage(node, "failed");
    node.status = "active";
    job(ws, { kind: "analyze_page", status: "failed", message: "AI unavailable · using embedding-only fallback", node_id: node.id, agent: 1 });
    // Fallback: embedding-similarity edge with honest reason (§14.6 rule 7)
    const other = d.nodes.find((n) => n.workspace_id === ws && n.type === "page" && n.id !== node.id && !n.deleted_at);
    if (other) {
      const e = makeEdge({
        workspace_id: ws, branch_id: node.branch_id, source_id: other.id, target_id: node.id, relation: "same_topic",
        origin: "embedding", confidence: 0.58, reason: "Similar content (AI explanation not available)", evidence: [],
      });
      d.edges.push(e);
      publish({ type: "edge.created", workspace_id: ws, by: null, data: e });
    }
    persist();
    return;
  }

  if (page && lib) {
    page.analysis_status = "done";
    page.summary = lib.summary;
    page.topics = lib.topics;
    page.page_type = lib.page_type;
    page.main_concept = lib.main_concept;
    page.is_research = lib.is_research;
    page.is_research_reason = lib.is_research_reason;
    page.claims = lib.claims.map((c, i) => ({ id: `${page.id}-c${i}`, page_id: page.id, ...c }));
    page.questions_answered = lib.questions_answered;
    publish({ type: "page.analyzed", workspace_id: ws, by: null, data: (({ content_text: _c, ...p }) => (void _c, p))(page) });
  }
  setStage(node, "understood");
  job(ws, { kind: "analyze_page", status: "done", message: `Agent 1 · Understood: ${lib?.main_concept ?? node.title}`, node_id: node.id, agent: 1 });

  // Not research → Inbox (§5.3)
  if (lib && !lib.is_research) {
    node.status = "inbox";
    setStage(node, "ready");
    job(ws, { kind: "analyze_page", status: "done", message: `Moved “${node.title}” to Inbox (not research)`, node_id: node.id, agent: 1 });
    persist();
    return;
  }

  await wait(900);
  setStage(node, "organizing");
  job(ws, { kind: "place_page", status: "running", message: "Agent 2 · Finding relationships…", node_id: node.id, agent: 2 });
  await wait(1500);

  // Placement: find/create topic group
  const topicName = lib?.topic ? TOPICS[lib.topic].name : null;
  let topic = topicName ? d.nodes.find((n) => n.workspace_id === ws && n.type === "topic" && n.title === topicName && !n.deleted_at) : undefined;
  if (!topic && topicName && lib?.topic) {
    const tops = d.nodes.filter((n) => n.workspace_id === ws && !n.parent_id && !n.deleted_at);
    const occupied = tops.map((n) => ({ x: n.x, y: n.y, w: n.width ?? sizeOf(n.type).w, h: n.height ?? sizeOf(n.type).h }));
    const pos = placeNear(occupied[occupied.length - 1] ?? null, { w: 600, h: 320 }, occupied);
    topic = makeNode({ workspace_id: ws, branch_id: node.branch_id, type: "topic", title: topicName, body: TOPICS[lib.topic].color, created_via: "ai", x: pos.x, y: pos.y });
    d.nodes.push(topic);
    publishNode("node.created", topic, null);
  }

  // Edges: up to 3 AI edges (§14.3)
  const candidates = d.nodes.filter((n) => n.workspace_id === ws && n.id !== node.id && !n.deleted_at && (n.type === "page" || n.type === "question"));
  const pageTopics = new Set((lib?.topics ?? []).map((t) => t.toLowerCase()));
  const scored = candidates
    .map((c) => {
      const cp = d.pages.find((p) => p.id === c.page_id);
      const overlap = (cp?.topics ?? []).filter((t) => pageTopics.has(t.toLowerCase())).length;
      const sameGroup = topic && c.parent_id === topic.id ? 1 : 0;
      return { c, cp, s: overlap + sameGroup };
    })
    .filter((x) => x.s > 0 && x.c.type === "page")
    .sort((a, b) => b.s - a.s)
    .slice(0, 2);
  const created: string[] = [];
  const opener = node.why_opened.opener_node_id ? d.nodes.find((n) => n.id === node.why_opened.opener_node_id) : undefined;
  if (opener) {
    const nav = makeEdge({
      workspace_id: ws, branch_id: node.branch_id, source_id: opener.id, target_id: node.id, relation: opener.type === "question" ? "answers" : "opened_from",
      origin: opener.type === "question" ? "ai" : "navigation", confidence: opener.type === "question" ? 0.86 : 1, state: opener.type === "question" ? "suggested" : "accepted",
      reason: opener.type === "question" ? `The page addresses the question “${opener.title}” and was opened from its search results.` : "Opened from this page (link click).",
      evidence: opener.type === "question" ? ["Opened from this search", `Covers: ${(lib?.topics ?? []).slice(0, 2).join(", ")}`] : ["Navigation trail"],
    });
    d.edges.push(nav);
    created.push(nav.id);
    publish({ type: "edge.created", workspace_id: ws, by: null, data: nav });
  }
  const rels: Relation[] = ["explains", "supports", "same_topic", "example_of"];
  scored.forEach(({ c, cp }, i) => {
    if (d.rejectedPairs.includes(`${c.id}:${node.id}`) || d.rejectedPairs.includes(`${node.id}:${c.id}`)) return;
    const shared = (cp?.topics ?? []).filter((t) => pageTopics.has(t.toLowerCase()));
    const rel = lib?.key === "pgvector-vs-pinecone" && cp?.main_concept === "pgvector" ? "alternative_to" : rels[i % rels.length]!;
    const conf = 0.6 * (0.78 - i * 0.08) + 0.3 * (0.7 - i * 0.05) + 0.1 * (opener?.id === c.id ? 1 : 0);
    const e = makeEdge({
      workspace_id: ws, branch_id: node.branch_id, source_id: c.id, target_id: node.id, relation: rel, confidence: Math.round(conf * 100) / 100,
      reason: `Both pages discuss ${shared.slice(0, 2).join(" and ") || "the same subject"}; “${node.title}” ${rel === "explains" ? "adds detail on" : "relates to"} “${c.title}”.`,
      evidence: shared.map((t) => `Both mention ${t}`).slice(0, 3),
    });
    d.edges.push(e);
    created.push(e.id);
    publish({ type: "edge.created", workspace_id: ws, by: null, data: e });
  });

  // Move node into group
  if (topic) {
    node.parent_id = topic.id;
    const children = relayoutTopic(topic);
    publishNode("node.updated", topic, null);
    children.forEach((c) => publishNode("node.updated", c, null));
  }
  setStage(node, "connected");
  job(ws, { kind: "place_page", status: "done", message: `Agent 2 · ${created.length} connection${created.length === 1 ? "" : "s"} found${topic ? ` · placed in “${topic.title}”` : ""}`, node_id: node.id, agent: 2 });

  await wait(700);
  node.status = "active";
  setStage(node, "ready");
  job(ws, { kind: "metadata", status: "done", message: "Agent 3 · Research Memory updated", node_id: node.id, agent: 3 });

  // Conflict check (§F16)
  if (opts.conflictWithKey && page && lib?.claims[0]) {
    await wait(1200);
    const otherLib = d.pages.find((p) => p.workspace_id === ws && p.url.includes(opts.conflictWithKey === "medpalm" ? "s41586-023-06291-2" : opts.conflictWithKey!));
    const otherNode = otherLib && d.nodes.find((n) => n.page_id === otherLib.id && !n.deleted_at);
    if (otherLib && otherNode && otherLib.claims[0]) {
      const conflict = {
        id: crypto.randomUUID(), workspace_id: ws, node_a_id: otherNode.id, node_b_id: node.id, label: "partially_contradict" as const,
        confidence: 0.71, status: "open" as const, resolution_note: null, resolved_by: null, cross_branch: otherNode.branch_id !== node.branch_id,
        created_at: new Date().toISOString(),
        analysis: {
          topic: "Are LLMs at expert level for medical questions?",
          claims: [
            { node_id: otherNode.id, added_by: userName(otherNode.created_by) ?? "You", claim: otherLib.claims[0].text, quote: otherLib.claims[0].quote, ref: null, title: otherLib.title, url: otherLib.url, fragment_url: textFragmentUrl(otherLib.url, otherLib.claims[0].quote) },
            { node_id: node.id, added_by: userName(opts.byUser) ?? "You", claim: lib.claims[0].text, quote: lib.claims[0].quote, ref: null, title: page.title, url: page.url, fragment_url: textFragmentUrl(page.url, lib.claims[0].quote) },
          ] as [never, never],
          key_differences: ["Exam-style questions vs real patient questions", "Benchmark scoring vs physician harm rating", "Different model versions and years"],
          possible_reasons: ["Methodology", "Dataset", "Evaluation conditions", "Timeframe"],
          context: "Source A measured benchmark accuracy on exam questions (2023). Source B asked physicians to rate answers to real patient questions (2025).",
          how_to_evaluate: ["Compare question sources", "Check how harm was defined", "Compare model versions"],
          label: "partially_contradict" as const,
          confidence: 0.71,
        },
      };
      d.conflicts.push(conflict);
      const e = makeEdge({
        workspace_id: ws, branch_id: node.branch_id, source_id: otherNode.id, target_id: node.id, relation: "contradicts", confidence: 0.71,
        reason: "The sources make claims about LLM medical accuracy that seem to disagree.", evidence: ["Benchmark vs real-world questions", "Different evaluation methods"],
      });
      d.edges.push(e);
      publish({ type: "edge.created", workspace_id: ws, by: null, data: e });
      publish({ type: "conflict.detected", workspace_id: ws, by: null, data: conflict });
    }
  }

  const radar = computeRadar(ws);
  publish({ type: "radar.updated", workspace_id: ws, by: null, data: radar });
  persist();
}

/** Re-organize (§14.5): group unlocked pages by their main topic, keep locked ones. */
export function reorganize(workspaceId: string): { moved: number; created: number } {
  const d = getDb();
  let moved = 0;
  let created = 0;
  const pages = d.nodes.filter((n) => n.workspace_id === workspaceId && n.type === "page" && !n.deleted_at && n.status !== "inbox");
  const topics = () => d.nodes.filter((n) => n.workspace_id === workspaceId && n.type === "topic" && !n.deleted_at);
  pages.forEach((n) => {
    if (n.group_locked || n.parent_id) return;
    const p = d.pages.find((x) => x.id === n.page_id);
    const first = p?.topics[0];
    if (!first) return;
    let t = topics().find((x) => x.title.toLowerCase().includes(first.toLowerCase()) || first.toLowerCase().includes(x.title.toLowerCase().split(" ")[0]!));
    if (!t) {
      const tops = d.nodes.filter((x) => x.workspace_id === workspaceId && !x.parent_id && !x.deleted_at);
      const occupied = tops.map((x) => ({ x: x.x, y: x.y, w: x.width ?? sizeOf(x.type).w, h: x.height ?? sizeOf(x.type).h }));
      const pos = placeNear(occupied[0] ?? null, { w: 600, h: 320 }, occupied);
      t = makeNode({ workspace_id: workspaceId, branch_id: n.branch_id, type: "topic", title: first, body: "#ee7048", created_via: "ai", x: pos.x, y: pos.y });
      d.nodes.push(t);
      created++;
    }
    n.parent_id = t.id;
    moved++;
  });
  topics().forEach((t) => relayoutTopic(t));
  return { moved, created };
}

export function radarSuggest(workspaceId: string, topicOrItemId: string, title: string) {
  const d = getDb();
  const s = suggestSearches(title);
  d.radarSuggestions[topicOrItemId] = s;
  persist();
  return s;
}

export { serializeNode };
