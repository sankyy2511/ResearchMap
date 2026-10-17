"use client";
/** Custom React Flow nodes (§F5): Page, Question, Note, Finding, Topic group. All memoized. */
import { memo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Handle, NodeResizer, Position, useStore, type NodeProps } from "@xyflow/react";
import { motion } from "motion/react";
import {
  CaretDown,
  CaretRight,
  Lightbulb,
  Lock,
  NotePencil,
  Question,
  Sparkle,
  Warning,
} from "@phosphor-icons/react";
import type { ResearchNode } from "@/types/api";
import { cn } from "@/lib/utils/cn";
import { truncate } from "@/lib/utils/format";
import { AI_STAGES, isProcessing, stageIndex, TAB_STATE_META } from "@/lib/domain/meta";
import { normalizeUrl } from "@/lib/utils/url";
import { Markdown } from "@/components/ui/primitives";
import { useGraphStore, type RFNode } from "@/stores/graph";
import { useExtensionStore } from "@/stores/extension";
import { updateNode } from "@/features/graph/actions";
import { useAccent, useNodeSignals, useZoomedOut } from "./useNodeLook";
import { Favicon, PagePreview } from "./PagePreview";
import { NODE_SIZE } from "@/lib/graph/layout";

type P = NodeProps<RFNode>;

// Tree lines enter at the top and leave at the bottom. Links are made automatically, so the points stay hidden.
function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} className="!opacity-0" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" isConnectable={false} />
    </>
  );
}

function Shell({
  node,
  selected,
  accent,
  className,
  children,
}: {
  node: ResearchNode;
  selected: boolean;
  accent: string;
  className?: string;
  children: ReactNode;
}) {
  const { viewer, flash, otherBranch } = useNodeSignals(node);
  return (
    <div
      className={cn(
        "relative rounded-[20px] border-2 bg-white transition-shadow",
        selected ? "border-ink shadow-pop-lg" : "border-ink/80 shadow-pop",
        flash && "animate-flash",
        className,
      )}
      style={{
        outline: otherBranch ? `3px dashed ${otherBranch.color}` : viewer ? `3px solid ${viewer.color}` : undefined,
        outlineOffset: 3,
      }}
    >
      <span className="absolute inset-x-4 -top-[2px] h-1.5 rounded-b-full" style={{ background: accent }} aria-hidden />
      {viewer && (
        <span className="absolute -top-3 right-3 z-10 rounded-full px-2 py-0.5 text-[10px] font-bold text-white" style={{ background: viewer.color }}>
          {viewer.name.split(" ")[0]}
        </span>
      )}
      {otherBranch && !viewer && (
        <span className="absolute -top-3 right-3 z-10 rounded-full px-2 py-0.5 text-[10px] font-bold text-white" style={{ background: otherBranch.color }}>
          {otherBranch.name}
        </span>
      )}
      {children}
      <Handles />
    </div>
  );
}

/* ---------------------------------------------------------------- Page */

/** Title size in pixels: grows when the map is zoomed out, so page names stay readable. */
function useTitleSize() {
  return useStore((s) => Math.min(28, Math.max(15, Math.round(14 / s.transform[2] / 3) * 3)));
}

export const PageNode = memo(function PageNode({ data, selected }: P) {
  const node = data.node;
  const page = useGraphStore((s) => (node.page_id ? s.pages[node.page_id] : undefined));
  const tab = useExtensionStore((s) => (page ? s.tabs[normalizeUrl(page.url)] : undefined));
  const mode = useExtensionStore((s) => s.previewMode[node.id] ?? "snapshot");
  const accent = useAccent(node);
  const { viewer, flash, otherBranch } = useNodeSignals(node);
  const tabState = mode === "live" ? "live" : (tab ?? "closed");
  const processing = isProcessing(node.ai_stage);
  const failed = node.ai_stage === "failed";
  const ring = otherBranch?.color ?? viewer?.color;
  const titleSize = useTitleSize();
  const readOnly = useGraphStore((s) => s.workspace?.my_role === "viewer");
  const [resizing, setResizing] = useState<{ width: number; height: number } | null>(null);
  const size = resizing ?? { width: node.width ?? NODE_SIZE.page.w, height: node.height ?? NODE_SIZE.page.h };

  return (
    <>
    {/* Drag a corner to make the page bigger, e.g. to read it in the interactive view. */}
    <NodeResizer
      isVisible={!!selected && !readOnly}
      minWidth={NODE_SIZE.page.w}
      minHeight={NODE_SIZE.page.h}
      lineClassName="!border-purple"
      handleClassName="!h-3 !w-3 !rounded-full !border-2 !border-ink !bg-white"
      onResize={(_, r) => setResizing({ width: r.width, height: r.height })}
      onResizeEnd={(_, r) => {
        setResizing(null);
        void updateNode(node.id, { width: Math.round(r.width), height: Math.round(r.height) }, { silent: true });
      }}
    />
    <motion.div
      initial={node.ai_stage === "captured" ? { scale: 0.6, opacity: 0 } : false}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 24 }}
      className={cn(
        "relative flex flex-col overflow-hidden rounded-[16px] border border-line bg-white [contain:layout_paint]",
        selected ? "shadow-pop-lg" : "shadow-pop",
        flash && "animate-flash",
      )}
      style={{ ...size, ...(ring ? { outline: `3px ${otherBranch ? "dashed" : "solid"} ${ring}`, outlineOffset: 3 } : {}) }}
    >
      {data.note && <span className="absolute right-2 top-11 z-10 rounded-full bg-ink px-2 py-0.5 text-[10px] font-semibold text-white">{data.note}</span>}
      {data.order && (
        <span className="absolute left-2 top-11 z-10 grid h-6 min-w-6 place-items-center rounded-full bg-brand-gradient px-1.5 text-[11px] font-black text-ink shadow-soft" title={`Page ${data.order} in the order you opened them`}>
          {data.order}
        </span>
      )}
      {/* Browser tab strip */}
      <div className="flex h-9 items-end gap-1 bg-canvas-cool pl-2 pr-1.5" style={{ boxShadow: `inset 0 3px 0 ${accent}` }}>
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-t-[10px] bg-white px-2.5" title={node.title}>
          {page ? <Favicon page={page} size={14} /> : <span className="h-3.5 w-3.5 rounded bg-ink/10" />}
          <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-ink">{node.title}</span>
          <span className={cn("h-2 w-2 shrink-0 rounded-full", TAB_STATE_META[tabState].dot, tabState === "active" && "animate-pulse")} title={TAB_STATE_META[tabState].label} />
        </div>
      </div>
      {/* Address bar */}
      <div className="flex items-center border-b border-line-cool bg-white px-2 py-1.5">
        <div className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-full bg-canvas-cool px-2.5 text-[10.5px] font-medium text-muted">
          <Lock size={10} weight="bold" className="shrink-0" />
          <span className="truncate">{page?.domain ?? "…"}</span>
        </div>
      </div>
      {/* Real page */}
      <div className="relative min-h-0 flex-1">
        {page ? <PagePreview page={page} mode={mode} refreshMs={tabState === "active" ? 10000 : tabState === "open" ? 30000 : undefined} /> : <div className="skeleton h-full rounded-none" />}
        {(processing || failed) && (
          <div className={cn("absolute inset-x-0 bottom-0 flex items-center gap-1.5 px-2.5 py-1.5 text-[10.5px] font-bold text-white", failed ? "bg-warning/90" : "bg-purple/90")}>
            {failed ? <Warning size={12} weight="fill" /> : <Sparkle size={12} weight="fill" className="animate-spin [animation-duration:2.4s]" />}
            {failed ? "AI unavailable" : AI_STAGES[stageIndex(node.ai_stage)]?.message}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-line bg-white px-3 py-2">
        <p className="line-clamp-2 font-display font-bold leading-snug text-ink" style={{ fontSize: titleSize }}>{node.title}</p>
      </div>
      <Handles />
    </motion.div>
    </>
  );
});

/* ---------------------------------------------------------------- Question */

export const QuestionNode = memo(function QuestionNode({ data, selected }: P) {
  const node = data.node;
  const accent = useAccent(node);
  const answers = useGraphStore((s) => s.edges.filter((e) => e.source === node.id && e.data?.edge.relation === "answers" && e.data.edge.state !== "rejected").length);
  return (
    <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 420, damping: 24 }}>
      <Shell node={node} selected={!!selected} accent={accent} className="w-[248px] rounded-[24px] rounded-bl-md bg-sky-soft">
        <div className="p-3.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-sky-deep">
            <Question size={13} weight="fill" /> Question
            {node.body && node.body !== "manual" && node.created_via !== "mcp" && <span className="normal-case tracking-normal text-muted">· from {node.body} search</span>}
          </div>
          <p className="mt-1.5 text-[14px] font-bold leading-snug text-ink">{node.title}</p>
          <div className="mt-2 flex items-center gap-2 text-[11px] font-bold">
            <span className={cn("rounded-full px-2 py-0.5", answers ? "bg-mint-soft text-mint-deep" : "bg-danger-soft text-danger")}>
              {answers ? `${answers} answer${answers === 1 ? "" : "s"}` : "No answers yet"}
            </span>
          </div>
        </div>
      </Shell>
    </motion.div>
  );
});

/* ---------------------------------------------------------------- Note */

export const NoteNode = memo(function NoteNode({ data, selected }: P) {
  const node = data.node;
  const accent = useAccent(node);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.body);
  return (
    <Shell node={node} selected={!!selected} accent={accent} className="w-[236px] bg-sun-soft">
      <div className="p-3.5" onDoubleClick={() => { setDraft(node.body); setEditing(true); }}>
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-sun-deep">
          <NotePencil size={13} weight="fill" /> Note
          {!editing && <span className="ml-auto normal-case tracking-normal text-faint">double-click to edit</span>}
        </div>
        <p className="mt-1 text-[13px] font-bold text-ink">{node.title}</p>
        {editing ? (
          <textarea
            autoFocus
            aria-label="Edit note (Markdown)"
            className="nodrag nowheel mt-1.5 min-h-24 w-full resize-none rounded-xl border-2 border-purple bg-white p-2 text-xs outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (draft !== node.body) void updateNode(node.id, { body: draft });
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur();
            }}
          />
        ) : (
          <Markdown text={truncate(node.body, 260)} className="mt-1 text-xs text-ink-soft" />
        )}
      </div>
    </Shell>
  );
});

/* ---------------------------------------------------------------- Finding */

export const FindingNode = memo(function FindingNode({ data, selected }: P) {
  const node = data.node;
  const accent = useAccent(node);
  const sources = useGraphStore(useShallow((s) =>
    s.edges.filter((e) => e.target === node.id && e.data?.edge.relation === "supports" && e.data.edge.state !== "rejected").map((e) => s.nodes.find((n) => n.id === e.source)?.data.node.title).filter(Boolean) as string[],
  ));
  return (
    <Shell node={node} selected={!!selected} accent={accent} className="w-[252px] bg-mint-soft">
      <div className="p-3.5">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-mint-deep">
          <Lightbulb size={13} weight="fill" /> Finding
          {node.created_via === "mcp" && <span className="ml-auto rounded-full bg-lavender-soft px-1.5 normal-case tracking-normal text-purple-deep">AI-suggested</span>}
        </div>
        <p className="mt-1.5 text-[13px] font-bold leading-snug text-ink">{node.title}</p>
        <p className="mt-2 text-[11px] font-semibold text-mint-deep">
          {sources.length ? `Supported by ${sources.length} source${sources.length === 1 ? "" : "s"}` : "No supporting sources linked"}
        </p>
        {sources.slice(0, 2).map((t) => (
          <p key={t} className="truncate text-[10px] text-muted">↳ {t}</p>
        ))}
      </div>
    </Shell>
  );
});

/* ---------------------------------------------------------------- Topic group */

export const TopicNode = memo(function TopicNode({ data, selected }: P) {
  const node = data.node;
  const color = node.body || "#ee7048";
  const count = useGraphStore((s) => s.nodes.filter((n) => n.parentId === node.id).length);
  const { flash } = useNodeSignals(node);
  const zoomedOut = useZoomedOut();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.title);
  return (
    <div
      className={cn("relative h-full w-full rounded-[32px] border-2 border-dashed transition-colors", selected ? "border-ink" : "", flash && "animate-flash")}
      style={{ background: `${color}14`, borderColor: selected ? undefined : `${color}88` }}
    >
      <NodeResizer isVisible={!!selected && !node.collapsed} minWidth={300} minHeight={180} lineClassName="!border-purple" handleClassName="!h-3 !w-3 !rounded-full !border-2 !border-ink !bg-white" />
      <div className="flex items-center gap-2 px-4 pt-3.5">
        <button
          className="nodrag grid h-7 w-7 place-items-center rounded-full bg-white shadow-clay-sm"
          aria-label={node.collapsed ? "Expand group" : "Collapse group"}
          onClick={(e) => {
            e.stopPropagation();
            void updateNode(node.id, { collapsed: !node.collapsed }, { silent: true });
          }}
        >
          {node.collapsed ? <CaretRight size={14} weight="bold" /> : <CaretDown size={14} weight="bold" />}
        </button>
        {editing ? (
          <input
            autoFocus
            className="nodrag h-8 min-w-0 flex-1 rounded-full border-2 border-purple bg-white px-3 text-sm font-bold outline-none"
            value={name}
            aria-label="Topic name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (name.trim() && name !== node.title) void updateNode(node.id, { title: name.trim() });
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <h3
            className={cn("min-w-0 truncate font-display font-bold tracking-tight text-ink", zoomedOut ? "text-3xl" : "text-[15px]")}
            onDoubleClick={() => {
              setName(node.title);
              setEditing(true);
            }}
            title="Double-click to rename"
          >
            {node.title}
          </h3>
        )}
        <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold text-white" style={{ background: color }}>
          {count}
        </span>
        {node.created_via === "ai" && !node.name_locked && (
          <span className="shrink-0 rounded-full bg-lavender-soft px-2 py-0.5 text-[10px] font-bold text-purple-deep" title="Group and name suggested by AI">
            <Sparkle size={10} weight="fill" className="mr-0.5 inline" />AI group
          </span>
        )}
      </div>
    </div>
  );
});

/* ---------------------------------------------------------------- Cluster (layout only) */

/** A soft box behind pages on the same topic or from the same search. Drawn by the layout, not stored. */
const ClusterNode = memo(function ClusterNode({ data }: { data: { label: string; color: string; count: number } }) {
  return (
    <div
      className="pointer-events-none h-full w-full rounded-[32px] border-2 border-dashed"
      style={{ borderColor: `${data.color}55`, background: `${data.color}0d` }}
    >
      <div className="flex min-w-0 items-center gap-2 px-6 pt-5" title={data.label}>
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: data.color }} />
        <span className="min-w-0 truncate font-display text-lg font-bold text-ink">{data.label}</span>
        <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-muted">· {data.count} {data.count === 1 ? "page" : "pages"}</span>
      </div>
    </div>
  );
});

export const nodeTypes = {
  page: PageNode,
  question: QuestionNode,
  note: NoteNode,
  finding: FindingNode,
  topic: TopicNode,
  cluster: ClusterNode,
};
