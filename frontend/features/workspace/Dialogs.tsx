"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toPng, toSvg } from "html-to-image";
import { getNodesBounds, getViewportForBounds, useReactFlow } from "@xyflow/react";
import { Check, Copy as CopyIcon, DownloadSimple, FileText, Link as LinkIcon, Trash } from "@phosphor-icons/react";
import type { ExportFormat, Role } from "@/types/api";
import { captureApi, exportApi, sharingApi } from "@/lib/api";
import { ApiError } from "@/lib/api/errors";
import { downloadDataUrl, downloadText, slugify } from "@/lib/utils/download";
import { isHttpUrl } from "@/lib/utils/url";
import { formatDate } from "@/lib/utils/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils/cn";
import { Modal } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Avatar, CopyField, Input, Label, Pill, Select } from "@/components/ui/primitives";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/ui/states";
import { useGraphStore } from "@/stores/graph";
import { useUiStore } from "@/stores/ui";
import { useCollabStore } from "@/stores/collab";
import { useAuthStore } from "@/stores/auth";
import { qk } from "@/features/workspaces/hooks";

const close = () => useUiStore.getState().setDialog(null);

/* ---------------------------------------------------------------- Share (F21) */

export function ShareDialog({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  const open = useUiStore((s) => s.dialog === "share");
  const qc = useQueryClient();
  const presence = useCollabStore((s) => s.presence);
  const me = useAuthStore((s) => s.user);
  const nodes = useGraphStore((s) => s.nodes);
  const members = useQuery({ queryKey: qk.members(workspaceId), queryFn: () => sharingApi.members(workspaceId), enabled: open });
  const links = useQuery({ queryKey: qk.links(workspaceId), queryFn: () => sharingApi.shareLinks(workspaceId), enabled: open && isOwner });
  const [role, setRole] = useState<"viewer" | "editor">("viewer"); // the safer choice comes first
  const [expires, setExpires] = useState("7");
  const create = useMutation({
    mutationFn: () => sharingApi.createShareLink(workspaceId, { role, expires_in_days: expires ? Number(expires) : null }),
    onSuccess: async (link) => {
      void qc.invalidateQueries({ queryKey: qk.links(workspaceId) });
      const copied = await navigator.clipboard?.writeText(link.url).then(() => true, () => false);
      toast.success(copied ? "Link created and copied" : "Link created", { description: copied ? "You can send it now." : "Copy it from the list below." });
    },
    onError: (e) => toast.apiError(e),
  });
  const disable = useMutation({ mutationFn: (id: string) => sharingApi.disableShareLink(workspaceId, id), onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.links(workspaceId) }); toast.info("Link turned off", { description: "People who joined with it lose access." }); } });
  const setMemberRole = useMutation({ mutationFn: ({ id, r }: { id: string; r: Role }) => sharingApi.updateMember(workspaceId, id, r), onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.members(workspaceId) }); toast.success("Role updated"); }, onError: (e) => toast.apiError(e) });
  const remove = useMutation({ mutationFn: (id: string) => sharingApi.removeMember(workspaceId, id), onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.members(workspaceId) }); toast.success("Member removed"); }, onError: (e) => toast.apiError(e) });

  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Share this workspace" description="Send a link. People open it after they sign in." size="lg">
      {isOwner && (
        <section className="rounded-2xl bg-white p-4 shadow-clay-sm">
          <h4 className="text-sm font-bold">Create a link</h4>
          <div className="mt-2 flex flex-wrap gap-2">
            <Select aria-label="What people can do" value={role} onChange={(e) => setRole(e.target.value as "viewer" | "editor")}>
              <option value="viewer">Can view only</option>
              <option value="editor">Can add and edit</option>
            </Select>
            <Select aria-label="Link expiry" value={expires} onChange={(e) => setExpires(e.target.value)}>
              <option value="1">Works for 1 day</option>
              <option value="7">Works for 7 days</option>
              <option value="">Works until you turn it off</option>
            </Select>
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}><LinkIcon size={16} weight="bold" /> Create and copy link</Button>
          </div>
          {!!links.data?.length && (
            <div className="mt-4 space-y-2 border-t border-line pt-3">
              <p className="text-xs font-bold text-muted">Links that work now</p>
              {links.data.map((l) => (
                <div key={l.id} className="flex flex-wrap items-center gap-2">
                  <Pill tone={l.role === "editor" ? "purple" : "sky"}>{l.role === "editor" ? "Can edit" : "Can view"}</Pill>
                  <div className="min-w-0 flex-1 basis-48"><CopyField value={l.url} /></div>
                  <span className="text-[11px] text-muted">{l.expires_at ? `until ${formatDate(l.expires_at)}` : "no end date"}</span>
                  <Button size="xs" variant="ghost" className="text-danger" onClick={() => disable.mutate(l.id)}>Turn off</Button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      <section className="mt-4 rounded-2xl bg-white p-4 shadow-clay-sm">
        <h4 className="text-sm font-bold">Members</h4>
        {members.isLoading && <LoadingBlock label="Loading members…" />}
        {members.error && <ErrorState error={members.error} onRetry={() => void members.refetch()} />}
        <ul className="mt-2 divide-y divide-line">
          {members.data?.map((m) => {
            const p = presence.find((x) => x.id === m.user_id);
            const sel = p?.selected_node_id ? nodes.find((n) => n.id === p.selected_node_id)?.data.node.title : null;
            return (
              <li key={m.user_id} className="flex items-center gap-3 py-2.5">
                <span className="relative">
                  <Avatar name={m.name} color={m.avatar_color} size={36} />
                  <span className={cn("absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white", p ? "bg-success" : "bg-faint")} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold">{m.name}{m.user_id === me?.id && " (you)"}</p>
                  <p className="truncate text-xs text-muted">{p ? (sel ? `Online · looking at “${sel}”` : "Online") : m.email}</p>
                </div>
                {isOwner && m.role !== "owner" ? (
                  <>
                    <Select aria-label={`Role for ${m.name}`} className="h-9 text-xs" value={m.role} onChange={(e) => setMemberRole.mutate({ id: m.user_id, r: e.target.value as Role })}>
                      <option value="editor">Can edit</option>
                      <option value="viewer">Can view</option>
                    </Select>
                    <Button size="icon-sm" variant="ghost" aria-label={`Remove ${m.name}`} onClick={() => remove.mutate(m.user_id)}><Trash size={16} /></Button>
                  </>
                ) : (
                  <Pill tone={m.role === "owner" ? "sun" : m.role === "editor" ? "purple" : "sky"}>{m.role === "owner" ? "Owner" : m.role === "editor" ? "Can edit" : "Can view"}</Pill>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </Modal>
  );
}

/* ---------------------------------------------------------------- Export (F20) */

const FORMATS: { id: ExportFormat | "png" | "svg"; label: string; hint: string }[] = [
  { id: "json", label: "JSON", hint: "Full workspace — can be imported back" },
  { id: "md", label: "Markdown", hint: "Topics, links, notes, connections, references" },
  { id: "png", label: "PNG image", hint: "Picture of the whole canvas" },
  { id: "svg", label: "SVG image", hint: "Vector picture of the canvas" },
  { id: "csv", label: "CSV", hint: "One row per page" },
  { id: "bookmarks", label: "Bookmarks HTML", hint: "Import into any browser" },
  { id: "mermaid", label: "Mermaid", hint: "Paste into GitHub / Notion docs" },
  { id: "bibtex", label: "BibTeX", hint: "References for papers" },
];

const BLANK_PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export function ExportDialog({ workspaceId }: { workspaceId: string }) {
  const open = useUiStore((s) => s.dialog === "export");
  const title = useGraphStore((s) => s.workspace?.title ?? "workspace");
  const rf = useReactFlow();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);

  const run = async (id: (typeof FORMATS)[number]["id"]) => {
    setBusy(id);
    try {
      if (id === "png" || id === "svg") {
        if (useUiStore.getState().viewMode !== "graph") throw new Error("Switch to Graph view to export an image.");
        const el = document.querySelector<HTMLElement>(".react-flow__viewport");
        if (!el) throw new Error("Canvas not found");
        const nodes = rf.getNodes().filter((n) => !n.hidden);
        const bounds = getNodesBounds(nodes);
        const w = Math.min(4000, Math.max(1200, bounds.width + 200));
        const h = Math.min(4000, Math.max(800, bounds.height + 200));
        const vp = getViewportForBounds(bounds, w, h, 0.05, 2, 0.05);
        // Favicons/previews from other sites often can't be fetched (CORS/404); without a placeholder html-to-image
        // rejects the whole capture with the image's error Event. A transparent pixel keeps the rest of the canvas.
        // Images from other websites (site icons) cannot be copied into a picture and break the whole capture, so they are left out.
        const sameSite = (n: HTMLElement) => !(n instanceof HTMLImageElement && /^https?:/.test(n.src) && new URL(n.src).origin !== location.origin);
        const opts = { backgroundColor: "#f5f1e8", width: w, height: h, imagePlaceholder: BLANK_PIXEL, pixelRatio: 1, filter: sameSite, // dpr 2 × 4000px exceeds the canvas limit and never resolves
          style: { width: `${w}px`, height: `${h}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` } };
        const url = await Promise.race([
          id === "png" ? toPng(el, opts) : toSvg(el, opts),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Image export timed out. Try zooming into a smaller area.")), 60000)),
        ]);
        downloadDataUrl(`${slugify(title)}.${id}`, url);
      } else {
        const r = await exportApi.export(workspaceId, id);
        downloadText(r.filename, r.content, r.mime);
      }
      setDone((d) => [...d, id]);
      toast.success("Export completed", { description: FORMATS.find((f) => f.id === id)!.label });
    } catch (e) {
      // Only API errors go to apiError; image-capture failures (DOMException, a DOM Event) get a specific message.
      if (e instanceof ApiError) toast.apiError(e);
      else toast.error("Export failed", { description: e instanceof Error ? e.message : "The canvas could not be captured as an image." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Export research" description="Download your links, notes and relationships." size="lg">
      <div className="grid gap-2 sm:grid-cols-2">
        {FORMATS.map((f) => (
          <button key={f.id} disabled={!!busy} onClick={() => void run(f.id)} className="flex items-center gap-3 rounded-2xl bg-white p-3 text-left shadow-clay-sm transition hover:-translate-y-0.5 disabled:opacity-60">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[30%] bg-lavender-soft text-purple-deep">
              {busy === f.id ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-purple border-t-transparent" /> : done.includes(f.id) ? <Check size={18} weight="bold" /> : <FileText size={18} weight="duotone" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold">{f.label}</span>
              <span className="block text-xs text-muted">{f.hint}</span>
            </span>
            <DownloadSimple size={18} className="text-faint" />
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">The PDF session report is available from Session → Report.</p>
    </Modal>
  );
}

/* ---------------------------------------------------------------- Add page manually (§5.3 "Add") */

export function AddPageDialog({ workspaceId }: { workspaceId: string }) {
  const open = useUiStore((s) => s.dialog === "add-page");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = isHttpUrl(url);
  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Add a page" description="Adds a page node. The AI pipeline analyses and connects it."
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={async () => {
        setBusy(true);
        try {
          // Empty title → the server uses the domain until Agent 1 fetches the real page title.
          const r = await captureApi.page({ workspace_id: workspaceId, url: url.trim(), title: title.trim(), transition: "manual" });
          if (r.is_new) toast.success("Page added", { description: "Analyzing page…" });
          else toast.info("This page is already in your workspace.", { description: "Jumped to the existing node." });
          close(); setUrl(""); setTitle("");
          setTimeout(() => { useUiStore.getState().selectNode(r.node_id); useUiStore.getState().requestFocus(r.node_id); }, 300);
        } catch (e) { toast.apiError(e); } finally { setBusy(false); }
      }}>Add page</Button></>}>
      <Label htmlFor="add-url">URL</Label>
      <Input id="add-url" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-invalid={!!url && !valid} />
      <div className="mt-3"><Label htmlFor="add-title" hint="Optional">Title</Label><Input id="add-title" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- Stop session → report */

export function StopSessionDialog({ workspaceId, sessionId, onStop }: { workspaceId: string; sessionId: string | null; onStop: () => Promise<string | null> }) {
  const open = useUiStore((s) => s.dialog === "stop-session");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Stop tracking?" size="sm"
      footer={<>
        <Button variant="ghost" onClick={close}>Keep tracking</Button>
        <Button variant="secondary" loading={busy} onClick={async () => { setBusy(true); await onStop(); setBusy(false); close(); }}>Stop</Button>
        <Button variant="primary" loading={busy} onClick={async () => { setBusy(true); const id = await onStop(); setBusy(false); close(); if (id) router.push(`/w/${workspaceId}/report/${id}?generate=1`); }}>Stop & generate report</Button>
      </>}>
      <p className="text-sm text-ink-soft">Tracking stops and the session is saved. You can generate a Session Report with statistics, summary and references.{!sessionId && " "}</p>
    </Modal>
  );
}

/* ---------------------------------------------------------------- Shortcuts */

export function ShortcutsDialog() {
  const open = useUiStore((s) => s.dialog === "shortcuts");
  const rows: [string, string][] = [
    ["Ctrl / ⌘ + K", "Search the workspace"],
    ["1 · 2 · 3 · 4 · 5", "Graph · Focus · List · Grid · Timeline"],
    ["Scroll / drag empty canvas / Space + drag", "Move the canvas"],
    ["Ctrl + scroll / pinch", "Zoom"],
    ["Double-click empty canvas", "New note there"],
    ["Delete / Backspace", "Delete selection (AI edges are rejected)"],
    ["Shift + drag / click", "Multi-select"],
    ["Double-click note / topic", "Edit in place"],
    ["Right-click", "Node or canvas menu"],
    ["N", "New note at the centre"],
    ["R", "Research Radar"],
    ["C", "Conflict Radar"],
    ["Esc", "Close panel"],
    ["?", "This help"],
  ];
  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Keyboard shortcuts" size="sm">
      <dl className="divide-y divide-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-4 py-2 text-sm"><dt className="text-ink-soft">{v}</dt><dd><kbd className="rounded-lg bg-white px-2 py-1 text-xs font-bold shadow-clay-sm">{k}</kbd></dd></div>
        ))}
      </dl>
    </Modal>
  );
}

export { EmptyState, CopyIcon };
