"use client";
/** Ctrl+K search (F12) over titles, URLs, page text, notes, highlights, tags, topics. Selecting zooms to the node. */
import { useEffect, useState } from "react";
import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { FileText, Folder, Highlighter, Lightbulb, MagnifyingGlass, NotePencil, Question, Tag } from "@phosphor-icons/react";
import type { SearchResultKind } from "@/types/api";
import { searchApi } from "@/lib/api";
import { cn } from "@/lib/utils/cn";
import { useUiStore } from "@/stores/ui";
import { useGraphStore } from "@/stores/graph";

const KIND: Record<SearchResultKind, { label: string; Icon: typeof FileText }> = {
  page: { label: "Pages", Icon: FileText },
  note: { label: "Notes", Icon: NotePencil },
  highlight: { label: "Highlights", Icon: Highlighter },
  tag: { label: "Tags", Icon: Tag },
  topic: { label: "Topics", Icon: Folder },
  question: { label: "Questions", Icon: Question },
  finding: { label: "Findings", Icon: Lightbulb },
};

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function CommandPalette({ workspaceId }: { workspaceId: string }) {
  const open = useUiStore((s) => s.searchOpen);
  const setOpen = useUiStore((s) => s.setSearchOpen);
  const tags = useGraphStore((s) => s.tags);
  const [q, setQ] = useState("");
  const [kinds, setKinds] = useState<SearchResultKind[]>([]);
  const dq = useDebounced(q, 200);
  const res = useQuery({
    queryKey: ["search", workspaceId, dq, kinds],
    queryFn: ({ signal }) => searchApi.search(workspaceId, dq, kinds.length ? { kinds } : {}, signal),
    enabled: open && dq.trim().length > 0,
    placeholderData: (p) => p,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useUiStore.getState().searchOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const select = (nodeId: string | null) => {
    if (!nodeId) return;
    setOpen(false);
    const ui = useUiStore.getState();
    if (ui.viewMode !== "graph" && ui.viewMode !== "focus") ui.setViewMode("graph");
    ui.selectNode(nodeId);
    setTimeout(() => useUiStore.getState().requestFocus(nodeId), 60);
  };

  const results = dq.trim() ? (res.data?.results ?? []) : [];
  const grouped = (Object.keys(KIND) as SearchResultKind[]).map((k) => [k, results.filter((r) => r.kind === k)] as const).filter(([, l]) => l.length);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-ink/40 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-[10vh] z-[71] w-[calc(100vw-1.5rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-[28px] border border-line bg-canvas shadow-float outline-none">
          <Dialog.Title className="sr-only">Search workspace</Dialog.Title>
          <Dialog.Description className="sr-only">Search pages, notes, highlights, tags and topics</Dialog.Description>
          <Command shouldFilter={false} label="Search workspace">
            <div className="flex items-center gap-3 border-b-2 border-ink/10 px-5">
              <MagnifyingGlass size={20} weight="bold" className="text-muted" />
              <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Search pages, notes, highlights, tags, topics…" className="h-14 flex-1 bg-transparent text-base font-medium outline-none placeholder:text-faint" />
              {res.isFetching && <span className="h-4 w-4 animate-spin rounded-full border-2 border-purple border-t-transparent" aria-label="Searching" />}
              <kbd className="rounded-lg bg-white px-2 py-1 text-[11px] font-bold text-muted shadow-clay-sm">Esc</kbd>
            </div>
            <div className="flex flex-wrap gap-1.5 px-5 py-2.5">
              {(Object.keys(KIND) as SearchResultKind[]).map((k) => (
                <button key={k} onClick={() => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]))} className={cn("rounded-full px-2.5 py-1 text-xs font-bold", kinds.includes(k) ? "bg-pill text-white" : "bg-white text-ink-soft shadow-clay-sm")}>
                  {KIND[k].label}
                </button>
              ))}
            </div>
            <Command.List className="max-h-[55vh] overflow-y-auto px-3 pb-3">
              {!dq.trim() && <p className="px-3 py-8 text-center text-sm text-muted">Type to search. Try “sensitivity”, “rag” or a tag like “Important”.</p>}
              {dq.trim() && !res.isFetching && res.data && !results.length && (
                <Command.Empty className="px-3 py-8 text-center text-sm text-muted">No matching research found.</Command.Empty>
              )}
              {grouped.map(([k, list]) => {
                const { label, Icon } = KIND[k];
                return (
                  <Command.Group key={k} heading={label} className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-faint">
                    {list.map((r) => (
                      <Command.Item key={r.id} value={r.id} onSelect={() => select(r.node_id)} className="flex cursor-pointer items-start gap-3 rounded-2xl px-3 py-2.5 data-[selected=true]:bg-white data-[selected=true]:shadow-clay-sm">
                        <Icon size={18} weight="duotone" className="mt-0.5 shrink-0 text-purple-deep" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold">{r.title}</p>
                          <p className="line-clamp-2 text-xs text-muted">{r.snippet}</p>
                          {r.tag_ids.length > 0 && (
                            <div className="mt-1 flex gap-1">
                              {r.tag_ids.map((id) => tags.find((t) => t.id === id)).filter(Boolean).slice(0, 3).map((t) => (
                                <span key={t!.id} className="rounded-full px-1.5 text-[10px] font-bold" style={{ background: `${t!.color}22`, color: t!.color }}>{t!.name}</span>
                              ))}
                            </div>
                          )}
                        </div>
                        <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-[10px] font-bold text-muted">{k}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                );
              })}
            </Command.List>
            {res.data && dq.trim() && <p className="border-t border-line px-5 py-2 text-[11px] text-faint">{results.length} results · {res.data.took_ms} ms · ↑↓ to move, Enter to jump</p>}
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
