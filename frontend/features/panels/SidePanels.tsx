"use client";
/** Edge "Why are these connected?" (F6), Research Radar (F17), Conflict Radar (F16), Research Memory (F15), AI Activity, Inbox, Branches (F22). */
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowsLeftRight,
  CheckCircle,
  GitBranch,
  NotePencil,
  Robot,
  Sparkle,
  Tray,
  X,
} from "@phosphor-icons/react";
import type { Conflict } from "@/types/api";
import { conflictApi } from "@/lib/api";
import { CONFLICT_LABEL, RELATIONS } from "@/lib/domain/meta";
import { timeAgo } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Confidence, Pill, Textarea } from "@/components/ui/primitives";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/ui/states";
import { useGraphStore } from "@/stores/graph";
import { useUiStore } from "@/stores/ui";
import { useSignalsStore } from "@/stores/collab";
import { useSessionStore } from "@/stores/session";
import { createNode, deleteEdge, rejectEdge, updateNode } from "@/features/graph/actions";
import { qk } from "@/features/workspaces/hooks";

const jump = (id: string) => {
  useUiStore.getState().selectNode(id);
  useUiStore.getState().requestFocus(id);
};

/* ---------------------------------------------------------------- Edge */

export function EdgePanel({ edgeId, readOnly }: { edgeId: string; readOnly: boolean }) {
  const edge = useGraphStore((s) => s.edges.find((e) => e.id === edgeId)?.data?.edge);
  const nodes = useGraphStore((s) => s.nodes);
  if (!edge) return <p className="text-sm text-muted">This link was removed.</p>;
  const titleOf = (id: string) => nodes.find((n) => n.id === id)?.data.node.title ?? "…";
  const page = (id: string) => (
    <button onClick={() => jump(id)} className="block w-full rounded-xl bg-white px-3 py-2 text-left text-sm font-semibold hover:bg-lavender-soft">{titleOf(id)}</button>
  );
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        {page(edge.source_id)}
        <p className="pl-3 text-sm text-muted">{RELATIONS[edge.relation].verb}</p>
        {page(edge.target_id)}
      </div>
      <section className="space-y-1.5">
        <h4 className="text-sm font-bold text-ink">Why</h4>
        <p className="text-sm leading-relaxed text-ink-soft">{edge.reason ?? "No reason was given."}</p>
      </section>
      {!readOnly && (
        <Button size="sm" variant="ghost" className="text-danger" onClick={() => void (edge.origin === "user" ? deleteEdge(edge.id) : rejectEdge(edge.id))}>
          <X size={14} weight="bold" /> Remove this link
        </Button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Research Radar */

function ConflictDetail({ c, readOnly, onBack }: { c: Conflict; readOnly: boolean; onBack: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const method = useMutation({ mutationFn: () => conflictApi.methodology(c.id), onError: (e) => toast.apiError(e) });
  const update = useMutation({
    mutationFn: (b: { status: Conflict["status"]; resolution_note?: string }) => conflictApi.update(c.id, b),
    onSuccess: (x) => { useSignalsStore.getState().upsertConflict(x); void qc.invalidateQueries({ queryKey: qk.conflicts(c.workspace_id) }); toast.success(x.status === "kept_both" ? "Kept both sources" : x.status === "resolved" ? "Marked as resolved" : x.status === "dismissed" ? "Dismissed" : "Reopened"); },
    onError: (e) => toast.apiError(e),
  });
  const addResolution = async () => {
    const a = useGraphStore.getState().nodes.find((n) => n.id === c.node_a_id);
    const pos = a ? { x: a.position.x + 40, y: a.position.y - 180 } : { x: 0, y: 0 };
    const n = await createNode("finding", pos, { title: note.trim() || `Resolution: ${c.analysis.topic}`, body: `Resolution of a potential conflict between two sources.\n\n${note}`, source_node_ids: [c.node_a_id, c.node_b_id], parent_id: null });
    if (n) update.mutate({ status: "resolved", resolution_note: note || n.title });
  };
  const [A, B] = c.analysis.claims;
  return (
    <div className="space-y-3">
      <button onClick={onBack} className="text-xs font-bold text-purple-deep">← All conflicts</button>
      <div className="rounded-2xl bg-coral-soft p-3">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-coral-deep">{CONFLICT_LABEL[c.label]}{c.cross_branch && " · cross-branch"}</p>
        <h4 className="mt-1 font-display text-base font-bold">{c.analysis.topic}</h4>
        <p className="mt-1 text-xs text-ink-soft">Surfaced for your review. The app never decides which source is correct.</p>
      </div>
      <div className="grid gap-2">
        {[A, B].map((side, i) => (
          <div key={i} className="rounded-2xl border border-line bg-white p-3 shadow-pop">
            <div className="flex items-center justify-between"><Pill tone={i ? "sky" : "sun"}>Source {i ? "B" : "A"}{side.ref ? ` · [${side.ref}]` : ""}</Pill><span className="text-[11px] text-muted">added by {side.added_by}</span></div>
            <button className="mt-1.5 text-left text-sm font-bold hover:text-purple-deep" onClick={() => jump(side.node_id)}>{side.title}</button>
            <p className="mt-1 text-sm">{side.claim}</p>
            <blockquote className="mt-1 border-l-4 border-sun pl-2 text-xs italic text-ink-soft">“{side.quote}”</blockquote>
            <a href={side.fragment_url} target="_blank" rel="noreferrer" className="mt-1.5 inline-block text-xs font-bold text-purple-deep">View evidence ↗</a>
          </div>
        ))}
        <div className="text-center font-display text-xs font-extrabold text-coral-deep">VS</div>
      </div>
      <section className="rounded-2xl bg-white p-4 shadow-clay-sm text-sm">
        <h4 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Context</h4>
        <p className="mt-1">{c.analysis.context}</p>
        <h4 className="mt-3 text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Key differences</h4>
        <ul className="mt-1 list-disc pl-5">{c.analysis.key_differences.map((d) => <li key={d}>{d}</li>)}</ul>
        <h4 className="mt-3 text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Possible reasons</h4>
        <div className="mt-1 flex flex-wrap gap-1">{c.analysis.possible_reasons.map((r) => <Pill key={r} tone="coral">{r}</Pill>)}</div>
        <h4 className="mt-3 text-[11px] font-bold uppercase tracking-[0.14em] text-muted">How to evaluate</h4>
        <ul className="mt-1 list-disc pl-5">{c.analysis.how_to_evaluate.map((d) => <li key={d}>{d}</li>)}</ul>
        <p className="mt-3 flex items-center gap-2 text-xs text-muted">AI confidence <Confidence value={c.confidence} /></p>
      </section>
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" variant="secondary" onClick={() => { useUiStore.getState().setFocusNode(c.node_a_id); useUiStore.getState().setViewMode("focus"); }}><ArrowsLeftRight size={12} weight="bold" /> Compare sources</Button>
        <Button size="xs" variant="secondary" loading={method.isPending} onClick={() => method.mutate()}><Sparkle size={12} weight="fill" /> Review methodology</Button>
      </div>
      {method.data && (
        <section className="rounded-2xl bg-lavender-soft p-3 text-sm">
          <p className="text-[11px] font-bold uppercase tracking-wider text-purple-deep">Methodology checklist · AI-generated</p>
          <ul className="mt-1 space-y-1">{method.data.checklist.map((i) => <li key={i.item}><Pill tone="ink">{i.source === "both" ? "Both" : i.source.toUpperCase()}</Pill> {i.item}</li>)}</ul>
        </section>
      )}
      {!readOnly && (
        <section className="rounded-2xl bg-white p-3 shadow-clay-sm">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Your resolution or note (optional)…" className="min-h-16 bg-canvas text-sm shadow-none" aria-label="Resolution note" />
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="xs" variant="secondary" onClick={() => update.mutate({ status: "kept_both", resolution_note: note || undefined })}>Keep both</Button>
            <Button size="xs" variant="success" onClick={() => update.mutate({ status: "resolved", resolution_note: note || undefined })}><CheckCircle size={12} weight="bold" /> Mark resolved</Button>
            <Button size="xs" variant="soft" onClick={() => void addResolution()}><NotePencil size={12} weight="bold" /> Add resolution to notes</Button>
            <Button size="xs" variant="ghost" onClick={() => update.mutate({ status: c.status === "dismissed" ? "open" : "dismissed" })}>{c.status === "dismissed" ? "Reopen" : "Dismiss"}</Button>
          </div>
          {c.resolution_note && <p className="mt-2 text-xs text-muted">Resolution: {c.resolution_note}</p>}
        </section>
      )}
    </div>
  );
}

export function ConflictPanel({ workspaceId, readOnly }: { workspaceId: string; readOnly: boolean }) {
  const q = useQuery({ queryKey: qk.conflicts(workspaceId), queryFn: () => conflictApi.list(workspaceId) });
  const live = useSignalsStore((s) => s.conflicts);
  const [openId, setOpenId] = useState<string | null>(null);
  if (q.isLoading) return <LoadingBlock label="Loading conflicts…" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const list = live.length ? live : q.data!;
  const current = list.find((c) => c.id === openId);
  if (current) return <ConflictDetail c={current} readOnly={readOnly} onBack={() => setOpenId(null)} />;
  if (!list.length) return <EmptyState compact icon={CheckCircle} tone="mint" title="No potential conflicts detected." message="When two sources seem to disagree, they'll appear here for your review." />;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">Potentially conflicting claims, surfaced for your review. You decide.</p>
      {list.map((c) => (
        <button key={c.id} onClick={() => setOpenId(c.id)} className={cn("w-full rounded-[22px] border-2 bg-white p-4 text-left transition hover:-translate-y-0.5", c.status === "open" ? "border-ink shadow-pop" : "border-line opacity-70")}>
          <div className="flex items-center gap-2"><Pill tone="coral">{CONFLICT_LABEL[c.label]}</Pill><Pill tone={c.status === "open" ? "sun" : "mint"}>{c.status.replace("_", " ")}</Pill><span className="ml-auto text-[11px] text-faint">{timeAgo(c.created_at)}</span></div>
          <p className="mt-2 font-bold">{c.analysis.topic}</p>
          <p className="mt-1 line-clamp-1 text-xs text-muted">A: {c.analysis.claims[0].claim}</p>
          <p className="line-clamp-1 text-xs text-muted">B: {c.analysis.claims[1].claim}</p>
          <span className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-purple-deep">Compare side by side <ArrowRight size={12} weight="bold" /></span>
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Research Memory */

export function ActivityPanel() {
  const jobs = useSessionStore((s) => s.jobs);
  if (!jobs.length) return <EmptyState compact icon={Robot} title="No AI work right now." message="When you open a page, Gemini reads it, writes a summary and links it to your other pages. You can watch each step here while it happens." />;
  return (
    <ol className="space-y-2">
      {jobs.map((j) => (
        <li key={j.id} className="flex items-start gap-2 rounded-2xl bg-white p-3 shadow-clay-sm">
          <span className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-extrabold", j.status === "failed" ? "bg-pink" : j.status === "running" ? "bg-lavender" : "bg-mint")}>
            {j.agent ? `A${j.agent}` : <Sparkle size={11} weight="fill" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{j.message}</p>
            <p className="text-[11px] text-faint">{j.status} · {new Date(j.at).toLocaleTimeString()}</p>
          </div>
          {j.node_id && <button className="text-xs font-bold text-purple-deep" onClick={() => jump(j.node_id!)}>View</button>}
        </li>
      ))}
    </ol>
  );
}

export function InboxPanel({ readOnly }: { readOnly: boolean }) {
  const inbox = useGraphStore(useShallow((s) => s.nodes.filter((n) => n.data.node.status === "inbox")));
  const pages = useGraphStore((s) => s.pages);
  if (!inbox.length) return <EmptyState compact icon={Tray} title="Inbox is empty." message="Pages the AI thinks are not research (music, social feeds…) land here instead of the graph." />;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">The AI marked these as “not research”. Move any of them to the graph.</p>
      {inbox.map((n) => (
        <div key={n.id} className="rounded-2xl bg-white p-3 shadow-clay-sm">
          <p className="font-bold">{n.data.node.title}</p>
          <p className="text-xs text-muted">{n.data.node.page_id && pages[n.data.node.page_id]?.is_research_reason}</p>
          {!readOnly && <Button size="xs" variant="soft" className="mt-2" onClick={() => void updateNode(n.id, { status: "active" })}>Move to graph</Button>}
        </div>
      ))}
    </div>
  );
}

export { GitBranch };
