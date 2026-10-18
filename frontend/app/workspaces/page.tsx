"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import {
  ArrowRight,
  Brain,
  DotsThreeVertical,
  FolderSimplePlus,
  Browsers,
  MagnifyingGlass,
  PencilSimple,
  Record,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react";
import type { Workspace } from "@/types/api";
import { AuthGate } from "@/components/shell/AuthGate";
import { AppHeader } from "@/components/shell/AppHeader";
import { Button } from "@/components/ui/button";
import { ArtTile, AvatarStack, Input, Kicker, Label, Pill } from "@/components/ui/primitives";
import { ConfirmDialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Modal } from "@/components/ui/overlay";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/states";
import { useCreateWorkspace, useDeleteWorkspace, useUpdateWorkspace, useWorkspaces } from "@/features/workspaces/hooks";
import { ImportDialog } from "@/features/export/ImportDialog";
import { ExtensionNotice } from "@/features/extension/ExtensionNotice";
import { pluralize, timeAgo } from "@/lib/utils/format";
import { sessionApi } from "@/lib/api";
import { API_MODE } from "@/lib/api/config";
import { extensionBridge } from "@/lib/extension/bridge";
import { toast } from "@/lib/toast";
import type { Tone } from "@/lib/domain/meta";

const TONES: Tone[] = ["lavender", "sun", "mint", "sky", "coral", "pink"];

function Sparkline({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <div className="flex h-8 items-end gap-1" aria-label={`Pages captured per day over the last week: ${data.join(", ")}`}>
      {data.map((v, i) => (
        <span key={i} className="w-2 rounded-full bg-purple/70" style={{ height: `${Math.max(8, (v / max) * 100)}%`, opacity: v ? 1 : 0.25 }} />
      ))}
    </div>
  );
}

function WorkspaceCard({ ws, index, onRename, onDelete }: { ws: Workspace; index: number; onRename: () => void; onDelete: () => void }) {
  const tone = TONES[index % TONES.length]!;
  const tracking = ws.active_session && ws.active_session.state !== "stopped";
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.35, delay: index * 0.04, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div className="group relative flex h-full flex-col overflow-hidden rounded-[28px] border border-line bg-white p-5 shadow-soft">
        <Link href={`/w/${ws.id}`} className="absolute inset-0 z-0 rounded-[28px]" aria-label={`Open ${ws.title}`} />
        <div className="relative z-10 flex items-start justify-between gap-3 pointer-events-none">
          <ArtTile icon={ws.node_count ? Browsers : Brain} tone={tone} size={48} />
          <div className="pointer-events-auto flex items-center gap-2">
            {tracking ? (
              <Pill tone="coral">
                <Record size={10} weight="fill" className="animate-pulse" /> {ws.active_session!.state === "paused" ? "Paused" : "Tracking"}
              </Pill>
            ) : (
              <Pill tone={ws.node_count ? "mint" : "ink"}>{ws.node_count ? "Active" : "Empty"}</Pill>
            )}
            <Menu>
              <MenuTrigger asChild>
                <button aria-label={`Actions for ${ws.title}`} className="grid h-8 w-8 place-items-center rounded-full hover:bg-ink/5">
                  <DotsThreeVertical size={20} weight="bold" />
                </button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={onRename} disabled={ws.my_role === "viewer"}>
                  <PencilSimple size={18} weight="bold" /> Rename
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger onSelect={onDelete} disabled={ws.my_role !== "owner"}>
                  <Trash size={18} weight="bold" /> Delete
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </div>
        <div className="relative z-10 mt-4 flex-1 pointer-events-none">
          <h3 className="text-lg font-bold leading-tight text-ink transition-colors duration-300 group-hover:text-purple-deep">{ws.title}</h3>
          {ws.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{ws.description}</p>}
        </div>
        <div className="relative z-10 mt-5 grid grid-cols-3 gap-2 pointer-events-none">
          {[
            [ws.node_count, "nodes"],
            [ws.page_count, "pages"],
            [ws.topic_count, "topics"],
          ].map(([v, l]) => (
            <div key={l as string} className="rounded-2xl bg-canvas px-3 py-2">
              <p className="tabular font-display text-xl font-extrabold text-ink">{v}</p>
              <p className="text-[11px] font-semibold text-muted">{l}</p>
            </div>
          ))}
        </div>
        <div className="relative z-10 mt-4 flex items-end justify-between gap-3 border-t border-line pt-4 pointer-events-none">
          <div>
            <AvatarStack people={ws.members.map((m) => ({ name: m.name, color: m.avatar_color }))} size={26} />
            <p className="mt-1.5 text-xs text-muted">
              {pluralize(ws.members.length, "member")} · opened {timeAgo(ws.last_opened_at)}
            </p>
          </div>
          <Sparkline data={ws.activity} />
        </div>
      </div>
    </motion.div>
  );
}

function WorkspacesView() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useWorkspaces();
  const create = useCreateWorkspace();
  const update = useUpdateWorkspace();
  const remove = useDeleteWorkspace();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [title, setTitle] = useState("");
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<Workspace | null>(null);
  const [stopping, setStopping] = useState(false);
  const deletingTracked = !!deleting?.active_session && deleting.active_session.state !== "stopped";
  const [q, setQ] = useState("");

  const list = useMemo(() => (data ?? []).filter((w) => w.title.toLowerCase().includes(q.toLowerCase())), [data, q]);

  const submitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const ws = await create.mutateAsync({ title }).catch(() => null);
    if (ws) {
      setCreating(false);
      setTitle("");
      router.push(`/w/${ws.id}?start=1`); // opens with the goal question
    }
  };

  return (
    <div className="min-h-dvh bg-app pb-28 md:pb-12">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 pt-8 sm:px-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Kicker tone="lavender">Your research</Kicker>
            <h1 className="mt-3 text-balance text-[1.875rem] font-extrabold leading-[1.1] sm:text-[2.5rem]">Workspaces</h1>
            <p className="mt-1 text-sm text-muted">One workspace for each research project.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setImporting(true)}>
              <UploadSimple size={18} weight="bold" /> Import
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <FolderSimplePlus size={18} weight="bold" /> New workspace
            </Button>
          </div>
        </div>

        <ExtensionNotice />

        {(data?.length ?? 0) > 3 && (
          <div className="relative mt-6 max-w-sm">
            <MagnifyingGlass size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-faint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter workspaces…" className="h-11 rounded-full pl-11" aria-label="Filter workspaces" />
          </div>
        )}

        <section className="mt-8">
          {isLoading ? (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-72 rounded-[28px]" />
              ))}
            </div>
          ) : error ? (
            <ErrorState error={error} onRetry={() => void refetch()} />
          ) : !data?.length ? (
            <EmptyState
              icon={Browsers}
              title="Create your first research workspace."
              message="A workspace keeps its own nodes, notes and connections. You can resume exactly where you stopped."
              action={
                <Button variant="purple" onClick={() => setCreating(true)}>
                  <FolderSimplePlus size={18} weight="bold" /> New workspace
                </Button>
              }
            />
          ) : !list.length ? (
            <EmptyState icon={MagnifyingGlass} compact title="No matching workspaces." message="Try a different name." />
          ) : (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((ws, i) => (
                <WorkspaceCard
                  key={ws.id}
                  ws={ws}
                  index={i}
                  onRename={() => {
                    setRenaming(ws);
                    setRenameValue(ws.title);
                  }}
                  onDelete={() => setDeleting(ws)}
                />
              ))}
              <button
                onClick={() => setCreating(true)}
                className="flex min-h-72 flex-col items-center justify-center gap-3 rounded-[28px] border-2 border-dashed border-ink/20 text-muted transition hover:border-purple hover:bg-white/50 hover:text-purple-deep"
              >
                <FolderSimplePlus size={32} weight="duotone" />
                <span className="text-sm font-bold">New workspace</span>
              </button>
            </div>
          )}
        </section>
      </main>

      <Modal
        open={creating}
        onOpenChange={setCreating}
        title="New workspace"
        description="A workspace keeps all pages for one research project. Next, you will set your goal."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="create-ws" loading={create.isPending} disabled={!title.trim()}>
              Create <ArrowRight size={16} weight="bold" />
            </Button>
          </>
        }
      >
        <form id="create-ws" onSubmit={submitCreate} className="space-y-4">
          <div>
            <Label htmlFor="ws-title">Name</Label>
            <Input id="ws-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. DevOps exam" maxLength={80} />
          </div>
        </form>
      </Modal>

      <Modal
        open={!!renaming}
        onOpenChange={(o) => !o && setRenaming(null)}
        title="Rename workspace"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={!renameValue.trim()}
              onClick={async () => {
                await update.mutateAsync({ id: renaming!.id, body: { title: renameValue } }).catch(() => null);
                setRenaming(null);
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <Label htmlFor="rename">Name</Label>
        <Input id="rename" autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={80} />
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deletingTracked ? "Tracking is still on" : "Delete workspace?"}
        danger
        confirmLabel={deletingTracked ? "Stop tracking and delete" : "Delete workspace"}
        loading={remove.isPending || stopping}
        message={
          deletingTracked ? (
            <>
              <strong>{deleting?.title}</strong> is being tracked right now. Tracking will stop, and the workspace with all its pages, notes,
              sessions and reports will be deleted for every member.
            </>
          ) : (
            <>
              <strong>{deleting?.title}</strong> and all its nodes, notes, sessions and reports will be deleted for every member.
            </>
          )
        }
        onConfirm={async () => {
          const ws = deleting!;
          if (deletingTracked) {
            // Stop the session first: a workspace that is being tracked cannot be deleted.
            setStopping(true);
            try {
              await sessionApi.stop(ws.active_session!.id);
              if (API_MODE === "http") extensionBridge.stopTracking();
            } catch (e) {
              toast.apiError(e);
              setStopping(false);
              return;
            }
            setStopping(false);
          }
          remove.mutate(ws.id);
          setDeleting(null);
        }}
      />
      <ImportDialog open={importing} onOpenChange={setImporting} />
    </div>
  );
}

export default function WorkspacesPage() {
  return (
    <AuthGate>
      <WorkspacesView />
    </AuthGate>
  );
}
