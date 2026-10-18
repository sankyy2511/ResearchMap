"use client";
/** List, Grid and Timeline views (§F13). Click → jump to graph. */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Browsers, ClockCounterClockwise } from "@phosphor-icons/react";
import { sessionApi } from "@/lib/api";
import { colorFromString, PAGE_TYPE_LABEL } from "@/lib/domain/meta";
import { formatDate, formatDuration, formatTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { Card, Pill, Select } from "@/components/ui/primitives";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/ui/states";
import { useGraphStore } from "@/stores/graph";
import { useUiStore } from "@/stores/ui";
import { Favicon, PagePreview } from "@/features/canvas/PagePreview";
import { qk } from "@/features/workspaces/hooks";

function openInGraph(id: string) {
  useUiStore.getState().setViewMode("graph");
  useUiStore.getState().selectNode(id);
  setTimeout(() => useUiStore.getState().requestFocus(id), 80);
}

function useRows() {
  const nodes = useGraphStore((s) => s.nodes);
  const pages = useGraphStore((s) => s.pages);
  const tags = useGraphStore((s) => s.tags);
  const categories = useGraphStore((s) => s.categories);
  const filters = useUiStore((s) => s.filters);
  return useMemo(() => {
    const topicName = (pid?: string) => (pid ? nodes.find((n) => n.id === pid)?.data.node.title : undefined) ?? "Unsorted";
    return nodes
      .map((n) => n.data.node)
      .filter((n) => n.type !== "topic" && n.status !== "inbox")
      .filter((n) => !filters.tag_ids.length || n.tag_ids.some((t) => filters.tag_ids.includes(t)))
      .filter((n) => !filters.category_ids.length || (n.category_id && filters.category_ids.includes(n.category_id)))
      .map((n) => {
        const p = n.page_id ? pages[n.page_id] : undefined;
        return {
          node: n,
          page: p,
          topic: topicName(n.parent_id ?? undefined),
          tags: n.tag_ids.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as { id: string; name: string; color: string }[],
          category: categories.find((c) => c.id === n.category_id),
        };
      });
  }, [nodes, pages, tags, categories, filters]);
}

type SortKey = "title" | "domain" | "topic" | "time" | "date";
type SortState = { key: SortKey; dir: 1 | -1 };

function SortTh({ k, children, sort, setSort }: { k: SortKey; children: React.ReactNode; sort: SortState; setSort: (f: (s: SortState) => SortState) => void }) {
  return (
    <th className="px-4 py-3" aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className="inline-flex items-center gap-1 uppercase" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (-s.dir as 1 | -1) : 1 }))}>
        {children} {sort.key === k && (sort.dir === 1 ? <ArrowUp size={11} weight="bold" /> : <ArrowDown size={11} weight="bold" />)}
      </button>
    </th>
  );
}

export function ListView() {
  const rows = useRows();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "date", dir: -1 });
  const sorted = useMemo(() => {
    const v = (r: (typeof rows)[number]) =>
      sort.key === "title" ? r.node.title : sort.key === "domain" ? (r.page?.domain ?? "") : sort.key === "topic" ? r.topic : sort.key === "time" ? r.node.activity.total_ms : r.node.created_at;
    return [...rows].sort((a, b) => (v(a) > v(b) ? 1 : v(a) < v(b) ? -1 : 0) * sort.dir);
  }, [rows, sort]);
  if (!rows.length) return <EmptyState icon={Browsers} title="No research yet." message="Start Tracking and browse normally." className="m-6" />;
  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-canvas text-left text-[11px] font-bold uppercase tracking-wider text-muted">
              <tr>
                <SortTh sort={sort} setSort={setSort} k="title">Title</SortTh>
                <SortTh sort={sort} setSort={setSort} k="domain">Domain</SortTh>
                <SortTh sort={sort} setSort={setSort} k="topic">Topic</SortTh>
                <th className="px-4 py-3">Tags</th>
                <th className="px-4 py-3">Category</th>
                <SortTh sort={sort} setSort={setSort} k="time">Time spent</SortTh>
                <th className="px-4 py-3">Added by</th>
                <SortTh sort={sort} setSort={setSort} k="date">Date</SortTh>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.node.id} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && openInGraph(r.node.id)} onClick={() => openInGraph(r.node.id)} className="cursor-pointer border-t border-line transition-colors hover:bg-canvas/60 focus:bg-lavender-soft focus:outline-none">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {r.page ? <Favicon page={r.page} /> : <Pill tone="lavender">{r.node.type}</Pill>}
                      <span className="line-clamp-1 font-semibold">{r.node.title}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted">{r.page?.domain ?? "—"}</td>
                  <td className="px-4 py-3">{r.topic}</td>
                  <td className="px-4 py-3"><div className="flex flex-wrap gap-1">{r.tags.map((t) => <span key={t.id} className="rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: `${t.color}22`, color: t.color }}>{t.name}</span>)}</div></td>
                  <td className="px-4 py-3">{r.category ? <span className="font-semibold" style={{ color: r.category.color }}>{r.category.name}</span> : "—"}</td>
                  <td className="tabular px-4 py-3">{formatDuration(r.node.activity.total_ms)}</td>
                  <td className="px-4 py-3 text-muted">{r.node.created_by_name ?? "—"}</td>
                  <td className="tabular px-4 py-3 text-muted">{formatDate(r.node.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

export function GridView() {
  const rows = useRows();
  const groups = useMemo(() => {
    const m = new Map<string, typeof rows>();
    rows.forEach((r) => m.set(r.topic, [...(m.get(r.topic) ?? []), r]));
    return [...m.entries()];
  }, [rows]);
  if (!rows.length) return <EmptyState icon={Browsers} title="No research yet." message="Start Tracking and browse normally." className="m-6" />;
  return (
    <div className="h-full space-y-8 overflow-auto p-4 sm:p-6">
      {groups.map(([topic, list]) => (
        <section key={topic}>
          <h3 className="mb-3 flex items-center gap-2 font-display text-lg font-bold">{topic} <Pill tone="lavender">{list.length}</Pill></h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {list.map((r) => (
              <Card key={r.node.id} interactive className="overflow-hidden" onClick={() => openInGraph(r.node.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && openInGraph(r.node.id)}>
                <div className="h-32 border-b border-line">
                  {r.page ? <PagePreview page={r.page} mode="snapshot" /> : <div className={cn("grid h-full place-items-center p-4 text-center text-sm font-semibold", r.node.type === "note" ? "bg-sun-soft" : r.node.type === "finding" ? "bg-mint-soft" : "bg-sky-soft")}>{r.node.type.toUpperCase()}</div>}
                </div>
                <div className="p-4">
                  <p className="line-clamp-2 text-sm font-bold">{r.node.title}</p>
                  <p className="mt-1 text-xs text-muted">{r.page ? `${r.page.domain} · ${r.page.page_type ? PAGE_TYPE_LABEL[r.page.page_type] : ""}` : r.node.type}</p>
                  <p className="tabular mt-2 text-xs font-semibold text-ink-soft">{formatDuration(r.node.activity.total_ms)}</p>
                </div>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function TimelineView({ workspaceId }: { workspaceId: string }) {
  const sessions = useQuery({ queryKey: qk.sessions(workspaceId), queryFn: () => sessionApi.list(workspaceId) });
  const [sid, setSid] = useState<string>("");
  const effective = sid || sessions.data?.[0]?.id || undefined;
  const q = useQuery({ queryKey: qk.journey(workspaceId, effective), queryFn: () => sessionApi.journey(workspaceId, effective), enabled: !!sessions.data });
  if (sessions.isLoading || q.isLoading) return <LoadingBlock label="Loading timeline…" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} className="m-6" />;
  const items = q.data?.items ?? [];
  if (!items.length)
    return (
      <div className="p-6">
        <EmptyState icon={ClockCounterClockwise} title="No tracked visits yet." message="Start Tracking and browse normally — each visit becomes a bar on this timeline." />
      </div>
    );
  const start = Date.parse(items[0]!.started_at);
  const end = Date.parse(items[items.length - 1]!.ended_at);
  const span = Math.max(60000, end - start);
  const lanes = [...new Set(items.map((i) => i.topic_name))];
  const ticks = Array.from({ length: 7 }, (_, i) => start + (span * i) / 6);
  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h3 className="font-display text-lg font-bold">Research timeline</h3>
        <Select aria-label="Session" className="h-9 text-xs" value={effective ?? ""} onChange={(e) => setSid(e.target.value)}>
          {sessions.data?.map((s) => <option key={s.id} value={s.id}>{s.title} · {formatDate(s.started_at)}</option>)}
        </Select>
        <span className="text-xs text-muted">Each bar is a visit, coloured by topic. Empty space = idle.</span>
      </div>
      <Card className="min-w-[760px] p-5">
        <div className="relative ml-44 h-6 border-b border-line text-[11px] font-semibold text-muted">
          {ticks.map((t) => (
            <span key={t} className="tabular absolute -translate-x-1/2" style={{ left: `${((t - start) / span) * 100}%` }}>{formatTime(new Date(t).toISOString())}</span>
          ))}
        </div>
        {lanes.map((lane) => (
          <div key={lane} className="flex items-center border-b border-line/60 py-2">
            <span className="w-44 shrink-0 truncate pr-3 text-sm font-bold">{lane}</span>
            <div className="relative h-8 flex-1 rounded-full bg-canvas">
              {items.filter((i) => i.topic_name === lane).map((i) => (
                <button
                  key={i.visit_id}
                  title={`${i.title} · ${formatDuration(i.duration_ms)} · ${formatTime(i.started_at)}`}
                  onClick={() => i.node_id && openInGraph(i.node_id)}
                  className="absolute top-1 h-6 rounded-full border border-line/70 transition hover:-translate-y-0.5 hover:border-ink"
                  style={{ left: `${((Date.parse(i.started_at) - start) / span) * 100}%`, width: `max(8px, ${(i.duration_ms / span) * 100}%)`, background: colorFromString(lane) }}
                  aria-label={`${i.title}, ${formatDuration(i.duration_ms)}`}
                />
              ))}
            </div>
          </div>
        ))}
      </Card>
      <Card variant="flat" className="mt-4 p-4">
        <h4 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Visit order</h4>
        <ol className="mt-2 grid gap-1 sm:grid-cols-2">
          {items.map((i, idx) => (
            <li key={i.visit_id}>
              <button className="w-full truncate rounded-xl px-2 py-1 text-left text-sm hover:bg-canvas" onClick={() => i.node_id && openInGraph(i.node_id)}>
                <span className="tabular mr-2 text-xs font-bold text-muted">{formatTime(i.started_at)}</span>
                {idx + 1}. {i.title}
              </button>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
