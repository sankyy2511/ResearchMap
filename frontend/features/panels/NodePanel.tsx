"use client";
/** Page details: what the page says, how you found it, related pages and your notes. Plain text only. */
import { useMemo, useState } from "react";
import { ArrowSquareOut, PencilSimple, Trash } from "@phosphor-icons/react";
import type { ResearchNode } from "@/types/api";
import { formatDuration, timeAgo } from "@/lib/utils/format";
import { extensionBridge } from "@/lib/extension/bridge";
import { cn } from "@/lib/utils/cn";
import { Button } from "@/components/ui/button";
import { Markdown, Textarea } from "@/components/ui/primitives";
import { useGraphStore } from "@/stores/graph";
import { useUiStore } from "@/stores/ui";
import { useExtensionStore } from "@/stores/extension";
import { addAnnotation, deleteAnnotation, deleteNodes, updateNode } from "@/features/graph/actions";
import { PagePreview } from "@/features/canvas/PagePreview";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h4 className="text-sm font-bold text-ink">{title}</h4>
      {children}
    </section>
  );
}

/** Switch to the page's tab when the extension is connected, else open it in a new tab. */
function openPage(url: string) {
  if (useExtensionStore.getState().connected) extensionBridge.goToTab(url);
  else extensionBridge.openUrl(url);
}

function Notes({ node, readOnly }: { node: ResearchNode; readOnly: boolean }) {
  const all = useGraphStore((s) => s.annotations);
  const notes = useMemo(() => Object.values(all).filter((a) => a.node_id === node.id && !a.parent_id).sort((a, b) => a.created_at.localeCompare(b.created_at)), [all, node.id]);
  const [text, setText] = useState("");
  const save = async () => {
    if (text.trim() && (await addAnnotation(node.id, "note", text.trim()))) setText("");
  };
  return (
    <Section title="Your notes">
      {notes.map((a) => (
        <div key={a.id} className="group rounded-xl bg-white px-3 py-2 text-sm text-ink-soft">
          {a.kind === "highlight" ? <p className="italic">“{a.quote}”</p> : <p className="whitespace-pre-wrap">{a.body}</p>}
          <div className="mt-1 flex items-center gap-2 text-xs text-faint">
            {timeAgo(a.created_at)}
            {!readOnly && <button className="ml-auto text-danger opacity-0 group-hover:opacity-100" onClick={() => void deleteAnnotation(a.id)}>Delete</button>}
          </div>
        </div>
      ))}
      {!readOnly && (
        <>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a note about this page…" className="min-h-16 text-sm"
            onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void save()} aria-label="New note" />
          <div className="flex justify-end">
            <Button size="xs" variant="primary" onClick={() => void save()} disabled={!text.trim()}>Save note</Button>
          </div>
        </>
      )}
    </Section>
  );
}

export function NodePanel({ nodeId, readOnly }: { nodeId: string; readOnly: boolean }) {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.node);
  const page = useGraphStore((s) => (node?.page_id ? s.pages[node.page_id] : undefined));
  const nodes = useGraphStore((s) => s.nodes);
  const mode = useExtensionStore((s) => s.previewMode[nodeId] ?? "snapshot");
  const setMode = useExtensionStore((s) => s.setPreviewMode);
  const [body, setBody] = useState<string | null>(null);

  if (!node) return <p className="p-6 text-sm text-muted">This page was deleted.</p>;
  const why = node.why_opened;
  const found = why.search_query ? `You searched for “${why.search_query}”.` : why.opener_title ? `You opened it from “${why.opener_title}”.` : "You opened it directly.";
  // Pages you opened from this one: a fact the extension recorded, not a guess.
  const openedNext = nodes.map((n) => n.data.node).filter((n) => n.why_opened?.opener_node_id === node.id);
  const visits = node.activity.visit_count;

  return (
    <div className="space-y-5 pb-2">
      <div>
        <h3 className="font-display text-lg font-bold leading-snug text-ink">{node.title}</h3>
        {page && <p className="mt-0.5 text-sm text-muted">{page.domain}</p>}
        <div className="mt-3 flex gap-2">
          {page && <Button size="sm" variant="purple" onClick={() => openPage(page.url)}><ArrowSquareOut size={15} weight="bold" /> Open page</Button>}
          {!readOnly && <Button size="sm" variant="ghost" className="text-danger" onClick={() => void deleteNodes([node.id])}><Trash size={15} weight="bold" /> Delete</Button>}
        </div>
      </div>

      {page && (
        <div>
          <div className="h-48 overflow-hidden rounded-xl border border-line">
            <PagePreview page={page} mode={mode} />
          </div>
          <div className="mt-2 flex gap-1 rounded-full bg-white p-1">
            {([["snapshot", "Picture"], ["interactive", "Interactive"]] as const).map(([m, label]) => (
              <button key={m} onClick={() => setMode(node.id, m)} className={cn("flex-1 rounded-full py-1.5 text-xs font-bold", mode === m ? "bg-pill text-white" : "text-ink-soft")}>{label}</button>
            ))}
          </div>
        </div>
      )}

      {page && (
        <Section title="Summary">
          {page.summary ? <p className="text-sm leading-relaxed text-ink-soft">{page.summary}</p> : <p className="text-sm text-muted">The summary is being written…</p>}
        </Section>
      )}

      {page && page.claims.length > 0 && (
        <Section title="Key points">
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
            {page.claims.map((c) => <li key={c.id}>{c.text}</li>)}
          </ul>
        </Section>
      )}

      {(node.type === "note" || node.type === "finding" || node.type === "question") && (
        <Section title="Text">
          {body !== null ? (
            <>
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-32 text-sm" aria-label="Text" />
              <div className="flex justify-end gap-2">
                <Button size="xs" variant="ghost" onClick={() => setBody(null)}>Cancel</Button>
                <Button size="xs" variant="primary" onClick={() => { void updateNode(node.id, { body }); setBody(null); }}>Save</Button>
              </div>
            </>
          ) : (
            <>
              {node.body ? <Markdown text={node.body} /> : <p className="text-sm text-muted">Nothing written yet.</p>}
              {!readOnly && <Button size="xs" variant="soft" onClick={() => setBody(node.body)}><PencilSimple size={13} /> Edit</Button>}
            </>
          )}
        </Section>
      )}

      {node.type === "page" && (
        <Section title="Your visit">
          <p className="text-sm text-ink-soft">
            {found} {node.activity.total_ms > 0 && `You spent ${formatDuration(node.activity.total_ms)} here${visits > 1 ? ` over ${visits} visits` : ""}.`}
          </p>
        </Section>
      )}

      {openedNext.length > 0 && (
        <Section title="Opened from this page">
          <ul className="space-y-2">
            {openedNext.map((n) => (
              <li key={n.id}>
                <button
                  className="w-full rounded-xl bg-white px-3 py-2 text-left text-sm font-semibold text-ink hover:text-purple-deep"
                  onClick={() => { useUiStore.getState().selectNode(n.id); useUiStore.getState().requestFocus(n.id); }}
                >
                  {n.title}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Notes node={node} readOnly={readOnly} />
    </div>
  );
}
