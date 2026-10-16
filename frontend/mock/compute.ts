/**
 * Server-side computations the Go backend owns (radar math, SQL stats, search, exports).
 * Implemented here with the exact definitions from §15 so the mock numbers are "real"
 * (derived from tracked visits), never invented.
 */
import type {
  ExportFormat,
  ExportResponse,
  JourneyItem,
  RadarItem,
  RadarResponse,
  Reference,
  SearchFilters,
  SearchResult,
  Session,
  SessionReportContent,
  SessionStats,
  TopicCoverage,
} from "@/types/api";
import { RELATIONS } from "@/lib/domain/meta";
import { slugify } from "@/lib/utils/download";
import { formatDateTime } from "@/lib/utils/format";
import { getDb, userName } from "./core";
import type { DbNode, DbPage, DbVisit } from "./db";

const ms = (v: DbVisit) => Date.parse(v.ended_at) - Date.parse(v.started_at);

function liveNodes(workspaceId: string) {
  return getDb().nodes.filter((n) => n.workspace_id === workspaceId && !n.deleted_at);
}
function pageOf(node: DbNode): DbPage | undefined {
  return node.page_id ? getDb().pages.find((p) => p.id === node.page_id) : undefined;
}
function topicOfPage(workspaceId: string, pageId: string | null): { id: string | null; name: string } {
  const d = getDb();
  const node = d.nodes.find((n) => n.workspace_id === workspaceId && n.page_id === pageId && !n.deleted_at);
  const parent = node?.parent_id ? d.nodes.find((n) => n.id === node.parent_id) : undefined;
  return parent ? { id: parent.id, name: parent.title } : { id: null, name: "Unsorted" };
}
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/* ---------------------------------------------------------------- Research Radar (F17) */

export function computeRadar(workspaceId: string): RadarResponse {
  const d = getDb();
  const nodes = liveNodes(workspaceId);
  const topics = nodes.filter((n) => n.type === "topic");
  const pages = nodes.filter((n) => n.type === "page" && n.status !== "inbox");
  const visits = d.visits.filter((v) => v.workspace_id === workspaceId);

  const raw = topics.map((t) => {
    const children = nodes.filter((n) => n.parent_id === t.id);
    const childPages = children.filter((n) => n.type === "page");
    const pageIds = new Set(childPages.map((n) => n.page_id));
    const minutes = visits.filter((v) => pageIds.has(v.page_id)).reduce((s, v) => s + ms(v), 0) / 60000;
    const notes =
      d.annotations.filter((a) => a.kind !== "comment" && children.some((c) => c.id === a.node_id)).length +
      children.filter((c) => c.type === "finding" || c.type === "note").length;
    return { t, s: childPages.length, minutes, notes };
  });
  const ms_ = median(raw.map((r) => r.s));
  const mt = median(raw.map((r) => r.minutes));
  const mn = median(raw.map((r) => r.notes));
  const eligible = topics.length >= 3 && pages.length >= 8;
  const avgSources = raw.length ? raw.reduce((a, r) => a + r.s, 0) / raw.length : 0;

  const coverage: TopicCoverage[] = raw.map((r) => {
    let c = 0;
    if (ms_ > 0) c += 0.6 * Math.min(r.s / ms_, 2);
    if (mt > 0) c += 0.3 * Math.min(r.minutes / mt, 2);
    if (mn > 0) c += 0.1 * Math.min(r.notes / mn, 2);
    return {
      topic_id: r.t.id,
      topic_name: r.t.title,
      sources: r.s,
      minutes: Math.round(r.minutes),
      notes: r.notes,
      coverage: Math.round(c * 100) / 100,
      flagged: eligible && c < 0.4,
    };
  });

  const items: RadarItem[] = [];
  const statusOf = (id: string) => d.radarStatus[id] ?? "open";
  coverage
    .filter((c) => c.flagged)
    .forEach((c) => {
      const id = `low:${c.topic_id}`;
      items.push({
        id,
        kind: "low_coverage",
        topic_id: c.topic_id,
        node_id: c.topic_id,
        title: c.topic_name,
        message: `This area appears under-covered in your workspace. Current sources: ${c.sources} (other topics have ${Math.round(avgSources)} on average).`,
        source_count: c.sources,
        avg_sources: Math.round(avgSources * 10) / 10,
        coverage: c.coverage,
        related_node_ids: nodes.filter((n) => n.parent_id === c.topic_id).map((n) => n.id),
        suggested_searches: d.radarSuggestions[c.topic_id!] ?? null,
        status: statusOf(id),
      });
    });

  // Unanswered questions
  nodes
    .filter((n) => n.type === "question")
    .forEach((q) => {
      const answered = d.edges.some((e) => e.source_id === q.id && e.relation === "answers" && e.state !== "rejected");
      if (answered) return;
      const id = `q:${q.id}`;
      items.push({
        id,
        kind: "unanswered_question",
        topic_id: q.parent_id,
        node_id: q.id,
        title: q.title,
        message: "This question has no page that answers it yet in your workspace.",
        source_count: 0,
        avg_sources: Math.round(avgSources * 10) / 10,
        coverage: null,
        related_node_ids: [q.id],
        suggested_searches: d.radarSuggestions[q.id] ?? null,
        status: statusOf(id),
      });
    });

  // Mentioned but not explored: concept in topics of 3+ pages with no own group or page
  const counts = new Map<string, string[]>();
  pages.forEach((n) => {
    pageOf(n)?.topics.forEach((t) => {
      const k = t.toLowerCase();
      counts.set(k, [...(counts.get(k) ?? []), n.id]);
    });
  });
  const explored = new Set([
    ...topics.map((t) => t.title.toLowerCase()),
    ...pages.map((n) => (pageOf(n)?.main_concept ?? "").toLowerCase()),
  ]);
  counts.forEach((nodeIds, concept) => {
    if (nodeIds.length < 3) return;
    const isExplored = [...explored].some((e) => e.includes(concept) || concept.includes(e.split(" ")[0] ?? "~"));
    if (isExplored) return;
    const display = pages.flatMap((n) => pageOf(n)?.topics ?? []).find((t) => t.toLowerCase() === concept) ?? concept;
    const id = `concept:${concept}`;
    items.push({
      id,
      kind: "unexplored_concept",
      topic_id: null,
      node_id: null,
      title: display,
      message: `Mentioned by ${nodeIds.length} pages but has no page or group of its own yet.`,
      source_count: 0,
      avg_sources: Math.round(avgSources * 10) / 10,
      coverage: null,
      related_node_ids: nodeIds,
      suggested_searches: d.radarSuggestions[id] ?? null,
      status: statusOf(id),
    });
  });

  return {
    eligible,
    eligibility_message: eligible ? null : "Radar starts after 3 topics and 8 pages, so small workspaces are not flagged wrongly.",
    items,
    topics: coverage.sort((a, b) => a.coverage - b.coverage),
    computed_at: new Date().toISOString(),
  };
}

const PRESET_SEARCHES: Record<string, string[]> = {
  "healthcare regulation": ["healthcare AI regulation", "medical AI compliance", "AI regulation India"],
};
export function suggestSearches(title: string): string[] {
  const k = title.toLowerCase();
  if (PRESET_SEARCHES[k]) return PRESET_SEARCHES[k]!;
  return [`${title} overview`, `${title} in healthcare 2026`, `${title} evidence review`];
}

/* ---------------------------------------------------------------- journey + stats (F14/F15/F18) */

export function sessionVisits(sessionId: string): DbVisit[] {
  return getDb()
    .visits.filter((v) => v.session_id === sessionId)
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
}

export function computeJourney(workspaceId: string, sessionId?: string): JourneyItem[] {
  const d = getDb();
  const visits = d.visits
    .filter((v) => v.workspace_id === workspaceId && (!sessionId || v.session_id === sessionId))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  return visits.map((v) => {
    const node = d.nodes.find((n) => n.page_id === v.page_id && n.workspace_id === workspaceId && !n.deleted_at);
    const page = d.pages.find((p) => p.id === v.page_id);
    const topic = topicOfPage(workspaceId, v.page_id);
    return {
      visit_id: v.id,
      node_id: node?.id ?? null,
      page_id: v.page_id,
      url: v.url,
      title: page?.title ?? v.url,
      topic_id: topic.id,
      topic_name: topic.name,
      started_at: v.started_at,
      ended_at: v.ended_at,
      duration_ms: ms(v),
    };
  });
}

export function sessionActiveMs(session: Session): number {
  return sessionVisits(session.id).reduce((s, v) => s + ms(v), 0);
}

export function computeStats(session: Session): SessionStats {
  const d = getDb();
  const visits = sessionVisits(session.id);
  const end = session.ended_at ? Date.parse(session.ended_at) : Date.now();
  const total = end - Date.parse(session.started_at) - session.paused_ms;
  const byPage = new Map<string, { title: string; page_id: string | null; ms: number }>();
  const bySite = new Map<string, number>();
  visits.forEach((v) => {
    const page = d.pages.find((p) => p.id === v.page_id);
    const key = v.page_id ?? v.url;
    const pg = byPage.get(key) ?? { title: page?.title ?? v.url, page_id: v.page_id ?? null, ms: 0 };
    pg.ms += ms(v);
    byPage.set(key, pg);
    const site = page?.domain ?? v.url;
    bySite.set(site, (bySite.get(site) ?? 0) + ms(v));
  });
  return {
    session_id: session.id,
    total_duration_ms: Math.max(0, total),
    active_ms: visits.reduce((s, v) => s + ms(v), 0),
    pages_visited: new Set(visits.map((v) => v.page_id ?? v.url)).size,
    sources_count: d.references.filter((r) => r.session_id === session.id).length,
    time_per_page: [...byPage.values()].sort((a, b) => b.ms - a.ms).slice(0, 12),
    time_per_site: [...bySite.entries()].map(([site, ms]) => ({ site, ms })).sort((a, b) => b.ms - a.ms).slice(0, 8),
  };
}

/* ---------------------------------------------------------------- references (F19) */

export function computeReferences(sessionId: string): Reference[] {
  const d = getDb();
  return d.references
    .filter((r) => r.session_id === sessionId)
    .sort((a, b) => a.ref_number - b.ref_number)
    .map((r) => {
      const page = d.pages.find((p) => p.id === r.page_id)!;
      const node = d.nodes.find((n) => n.page_id === r.page_id && !n.deleted_at);
      return {
        ref_number: r.ref_number,
        page_id: r.page_id,
        node_id: node?.id ?? null,
        title: page.title,
        url: page.url,
        domain: page.domain,
        site_name: page.site_name,
        author: page.author,
        published_at: page.published_at,
        first_accessed_at: r.first_accessed_at,
        added_by: userName(r.added_by),
      };
    });
}

export function referencesMarkdown(refs: Reference[]): string {
  return refs
    .map((r) => `[${r.ref_number}] ${r.title} — ${r.site_name ?? r.domain}\n    ${r.url}\n    Accessed: ${formatDateTime(r.first_accessed_at)}`)
    .join("\n\n");
}

export function referencesBibtex(refs: Reference[]): string {
  return refs
    .map((r) => {
      const key = `${slugify(r.site_name ?? r.domain).replace(/-/g, "")}${r.ref_number}`;
      const year = r.published_at ? new Date(r.published_at).getFullYear() : new Date(r.first_accessed_at).getFullYear();
      return [
        `@misc{${key},`,
        `  title = {${r.title}},`,
        r.author ? `  author = {${r.author}},` : null,
        `  howpublished = {\\url{${r.url}}},`,
        `  year = {${year}},`,
        `  note = {Accessed: ${new Date(r.first_accessed_at).toISOString().slice(0, 10)}}`,
        `}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/* ---------------------------------------------------------------- search (F12) */

function snippetAround(text: string, q: string, len = 140): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, len);
  const start = Math.max(0, i - 50);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + len)}${start + len < text.length ? "…" : ""}`;
}

/** Simple stand-in for full-text + trigram + vector search fused with RRF (§F12). */
function score(text: string | null | undefined, q: string, weight: number): number {
  if (!text) return 0;
  const t = text.toLowerCase();
  const query = q.toLowerCase().trim();
  if (!query) return 0;
  if (t.includes(query)) return weight * (t.startsWith(query) ? 1.3 : 1);
  const tokens = query.split(/\s+/).filter((w) => w.length > 1);
  const hits = tokens.filter((w) => t.includes(w) || (w.length > 4 && t.includes(w.slice(0, -1)))).length;
  return tokens.length ? (weight * 0.7 * hits) / tokens.length : 0;
}

export function search(workspaceId: string, q: string, filters: SearchFilters, visibleNodeIds: Set<string>): SearchResult[] {
  const d = getDb();
  const out: SearchResult[] = [];
  const kinds = filters.kinds?.length ? new Set(filters.kinds) : null;
  const want = (k: SearchResult["kind"]) => !kinds || kinds.has(k);
  const nodes = liveNodes(workspaceId).filter((n) => visibleNodeIds.has(n.id));
  const tagFilter = filters.tag_ids?.length ? new Set(filters.tag_ids) : null;
  const passesNodeFilters = (n: DbNode) => {
    if (tagFilter && !n.tag_ids.some((t) => tagFilter.has(t))) return false;
    const page = pageOf(n);
    if (filters.domains?.length && (!page || !filters.domains.includes(page.domain))) return false;
    if (filters.page_types?.length && (!page?.page_type || !filters.page_types.includes(page.page_type))) return false;
    return true;
  };

  nodes.forEach((n) => {
    if (!passesNodeFilters(n)) return;
    const page = pageOf(n);
    if (n.type === "page" && want("page")) {
      const s =
        score(n.title, q, 3) + score(page?.url, q, 1.5) + score(page?.summary, q, 1.5) + score(page?.content_text, q, 1) +
        score(page?.topics.join(" "), q, 2);
      if (s > 0)
        out.push({
          id: `page:${n.id}`, kind: "page", node_id: n.id, title: n.title,
          snippet: snippetAround(`${page?.summary ?? ""} ${page?.content_text ?? ""}`, q), url: page?.url ?? null, tag_ids: n.tag_ids, score: s,
        });
    }
    if (n.type === "topic" && want("topic")) {
      const s = score(n.title, q, 3);
      if (s > 0) out.push({ id: `topic:${n.id}`, kind: "topic", node_id: n.id, title: n.title, snippet: "Topic group", url: null, tag_ids: [], score: s });
    }
    if (n.type === "question" && want("question")) {
      const s = score(n.title, q, 3);
      if (s > 0) out.push({ id: `q:${n.id}`, kind: "question", node_id: n.id, title: n.title, snippet: "Question", url: null, tag_ids: n.tag_ids, score: s });
    }
    if ((n.type === "note" || n.type === "finding") && want(n.type === "note" ? "note" : "finding")) {
      const s = score(n.title, q, 2.5) + score(n.body, q, 2);
      if (s > 0)
        out.push({ id: `${n.type}:${n.id}`, kind: n.type === "note" ? "note" : "finding", node_id: n.id, title: n.title, snippet: snippetAround(n.body, q), url: null, tag_ids: n.tag_ids, score: s });
    }
  });

  d.annotations
    .filter((a) => a.workspace_id === workspaceId && visibleNodeIds.has(a.node_id))
    .forEach((a) => {
      const node = nodes.find((n) => n.id === a.node_id);
      if (!node || !passesNodeFilters(node)) return;
      if (a.kind === "highlight" && want("highlight")) {
        const s = score(a.quote, q, 2.2);
        if (s > 0) out.push({ id: `hl:${a.id}`, kind: "highlight", node_id: a.node_id, title: node.title, snippet: `“${a.quote}”`, url: a.fragment_url, tag_ids: [], score: s });
      } else if (a.kind !== "highlight" && want("note")) {
        const s = score(a.body, q, 2);
        if (s > 0) out.push({ id: `ann:${a.id}`, kind: "note", node_id: a.node_id, title: `${a.kind === "comment" ? "Comment" : "Note"} on ${node.title}`, snippet: snippetAround(a.body, q), url: null, tag_ids: [], score: s });
      }
    });

  if (want("tag")) {
    d.tags
      .filter((t) => t.workspace_id === workspaceId)
      .forEach((t) => {
        const s = score(t.name, q, 2.5);
        if (s <= 0) return;
        const tagged = nodes.filter((n) => n.tag_ids.includes(t.id));
        tagged.slice(0, 6).forEach((n) =>
          out.push({ id: `tag:${t.id}:${n.id}`, kind: "tag", node_id: n.id, title: n.title, snippet: `Tagged “${t.name}”`, url: null, tag_ids: [t.id], score: s * 0.9 }),
        );
      });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 40);
}

/* ---------------------------------------------------------------- export (F20) */

function exportData(workspaceId: string) {
  const d = getDb();
  const nodes = liveNodes(workspaceId);
  const ids = new Set(nodes.map((n) => n.id));
  return {
    workspace: d.workspaces.find((w) => w.id === workspaceId)!,
    nodes,
    edges: d.edges.filter((e) => e.workspace_id === workspaceId && e.state !== "rejected" && ids.has(e.source_id) && ids.has(e.target_id)),
    pages: d.pages.filter((p) => p.workspace_id === workspaceId),
    tags: d.tags.filter((t) => t.workspace_id === workspaceId),
    categories: d.categories.filter((c) => c.workspace_id === workspaceId),
    annotations: d.annotations.filter((a) => a.workspace_id === workspaceId),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const csvCell = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;

export function buildExport(workspaceId: string, format: ExportFormat): ExportResponse {
  const data = exportData(workspaceId);
  const d = getDb();
  const base = slugify(data.workspace.title);
  const pageOfNode = (n: DbNode) => data.pages.find((p) => p.id === n.page_id);
  const topics = data.nodes.filter((n) => n.type === "topic");
  const childrenOf = (id: string | null) => data.nodes.filter((n) => n.parent_id === id && n.type !== "topic");
  const title = (id: string) => data.nodes.find((n) => n.id === id)?.title ?? "?";
  const minutes = (n: DbNode) =>
    Math.round(d.visits.filter((v) => v.page_id === n.page_id && n.page_id).reduce((s, v) => s + ms(v), 0) / 60000);

  switch (format) {
    case "json": {
      const content = JSON.stringify({ format: "research-map/v1", exported_at: new Date().toISOString(), ...data, pages: data.pages.map(({ content_text: _c, ...p }) => (void _c, p)) }, null, 2);
      return { format, filename: `${base}.json`, mime: "application/json", content };
    }
    case "md": {
      const lines: string[] = [`# ${data.workspace.title}`, "", data.workspace.description, ""];
      const section = (heading: string, nodes: DbNode[]) => {
        if (!nodes.length) return;
        lines.push(`## ${heading}`, "");
        nodes.forEach((n) => {
          const p = pageOfNode(n);
          if (p) lines.push(`- [${n.title}](${p.url})${p.summary ? ` — ${p.summary}` : ""}`);
          else lines.push(`- **${n.type === "question" ? "Question" : n.type === "finding" ? "Finding" : "Note"}:** ${n.title}${n.body && n.type !== "question" ? ` — ${n.body.replace(/\n+/g, " ")}` : ""}`);
          data.annotations
            .filter((a) => a.node_id === n.id)
            .forEach((a) => lines.push(a.kind === "highlight" ? `  > “${a.quote}”` : `  - ${a.kind === "comment" ? "💬" : "📝"} ${a.body.replace(/\n+/g, " ")}`));
        });
        lines.push("");
      };
      topics.forEach((t) => section(t.title, childrenOf(t.id)));
      section("Unsorted", childrenOf(null));
      lines.push("## Connections", "");
      data.edges.forEach((e) => lines.push(`- ${title(e.source_id)} → (${e.relation}) → ${title(e.target_id)}${e.reason ? ` — ${e.reason}` : ""}`));
      lines.push("", "## References", "");
      data.pages.forEach((p, i) => lines.push(`[${i + 1}] ${p.title} — ${p.site_name ?? p.domain}  \n    ${p.url}`));
      return { format, filename: `${base}.md`, mime: "text/markdown", content: lines.join("\n") };
    }
    case "csv": {
      const rows = [["title", "url", "topic", "tags", "time_spent_min", "notes"].map(csvCell).join(",")];
      data.nodes
        .filter((n) => n.type === "page")
        .forEach((n) => {
          const p = pageOfNode(n);
          const topic = topics.find((t) => t.id === n.parent_id)?.title ?? "Unsorted";
          const tags = n.tag_ids.map((id) => data.tags.find((t) => t.id === id)?.name).filter(Boolean).join("; ");
          const notes = data.annotations.filter((a) => a.node_id === n.id && a.kind === "note").map((a) => a.body.replace(/\n+/g, " ")).join(" | ");
          rows.push([n.title, p?.url ?? "", topic, tags, minutes(n), notes].map(csvCell).join(","));
        });
      return { format, filename: `${base}.csv`, mime: "text/csv", content: rows.join("\n") };
    }
    case "bookmarks": {
      const folder = (name: string, nodes: DbNode[]) =>
        `    <DT><H3>${esc(name)}</H3>\n    <DL><p>\n${nodes
          .map((n) => pageOfNode(n))
          .filter(Boolean)
          .map((p) => `        <DT><A HREF="${esc(p!.url)}">${esc(p!.title)}</A>`)
          .join("\n")}\n    </DL><p>`;
      const content = [
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
        `<TITLE>${esc(data.workspace.title)}</TITLE>`,
        `<H1>${esc(data.workspace.title)}</H1>`,
        "<DL><p>",
        ...topics.map((t) => folder(t.title, childrenOf(t.id))),
        folder("Unsorted", childrenOf(null)),
        "</DL><p>",
      ].join("\n");
      return { format, filename: `${base}-bookmarks.html`, mime: "text/html", content };
    }
    case "mermaid": {
      const idOf = new Map(data.nodes.map((n, i) => [n.id, `n${i}`]));
      const label = (s: string) => s.replace(/["[\]()]/g, "").slice(0, 48);
      const lines = ["graph LR"];
      topics.forEach((t) => {
        lines.push(`  subgraph ${idOf.get(t.id)}["${label(t.title)}"]`);
        childrenOf(t.id).forEach((n) => lines.push(`    ${idOf.get(n.id)}["${label(n.title)}"]`));
        lines.push("  end");
      });
      childrenOf(null).forEach((n) => lines.push(`  ${idOf.get(n.id)}["${label(n.title)}"]`));
      data.edges.forEach((e) => {
        const a = idOf.get(e.source_id);
        const b = idOf.get(e.target_id);
        if (a && b) lines.push(`  ${a} -->|${RELATIONS[e.relation].label}| ${b}`);
      });
      return { format, filename: `${base}.mmd`, mime: "text/plain", content: lines.join("\n") };
    }
    case "bibtex": {
      const refs: Reference[] = data.pages.map((p, i) => ({
        ref_number: i + 1, page_id: p.id, node_id: null, title: p.title, url: p.url, domain: p.domain, site_name: p.site_name,
        author: p.author, published_at: p.published_at, first_accessed_at: p.created_at, added_by: null,
      }));
      return { format, filename: `${base}.bib`, mime: "application/x-bibtex", content: referencesBibtex(refs) };
    }
  }
}

/* ---------------------------------------------------------------- report (F18) */

export function buildReportContent(session: Session): SessionReportContent {
  const d = getDb();
  const stats = computeStats(session);
  const refs = computeReferences(session.id);
  const refFor = (nodeId: string) => {
    const node = d.nodes.find((n) => n.id === nodeId);
    return refs.find((r) => r.page_id === node?.page_id)?.ref_number ?? null;
  };
  const findings = d.nodes.filter((n) => n.workspace_id === session.workspace_id && n.type === "finding" && !n.deleted_at);
  const keyFindings = findings.map((f) => {
    const sourceRefs = d.edges
      .filter((e) => e.target_id === f.id && e.relation === "supports")
      .map((e) => refFor(e.source_id))
      .filter((n): n is number => n != null);
    return { text: f.title, refs: sourceRefs, ai_generated: false };
  });
  const sessionPageIds = new Set(refs.map((r) => r.page_id));
  d.pages
    .filter((p) => sessionPageIds.has(p.id) && p.claims.length)
    .slice(0, 3)
    .forEach((p) => {
      const ref = refs.find((r) => r.page_id === p.id)?.ref_number;
      keyFindings.push({ text: p.claims[0]!.text, refs: ref ? [ref] : [], ai_generated: true });
    });
  const summary = `You read ${stats.pages_visited} pages in this session. Active reading time was ${Math.round(stats.active_ms / 60000)} minutes out of ${Math.round(stats.total_duration_ms / 60000)} minutes.`;
  return { summary, key_findings: keyFindings };
}
