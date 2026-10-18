"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChartBar,
  ClockCounterClockwise,
  DotsThreeOutline,
  DownloadSimple,
  Export,
  Browsers,
  FrameCorners,
  LinkSimple,
  Keyboard,
  ListBullets,
  MagnifyingGlass,
  NotePencil,
  Pause,
  Play,
  Plus,
  Record,
  Robot,
  ShareNetwork,
  Stop,
  Sword,
  WifiSlash,
  X,
} from "@phosphor-icons/react";
import type { PanelKind, Session, ViewMode } from "@/types/api";
import { sessionApi, workspaceApi } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils/cn";
import { formatClock } from "@/lib/utils/format";
import { browsingSimulator } from "@/lib/extension/simulator";
import { API_MODE } from "@/lib/api/config";
import { connectExtension, extensionBridge } from "@/lib/extension/bridge";
import { EXTENSION_ZIP } from "@/features/extension/InstallGuide";
import { useExtensionStore } from "@/stores/extension";
import { Button } from "@/components/ui/button";
import { AvatarStack, Segmented, Tip } from "@/components/ui/primitives";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Modal } from "@/components/ui/overlay";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/ui/states";
import { UserMenu } from "@/components/shell/AppHeader";
import { useGraphStore } from "@/stores/graph";
import { useUiStore } from "@/stores/ui";
import { sessionElapsed, useSessionStore } from "@/stores/session";
import { useCollabStore, useSignalsStore } from "@/stores/collab";
import { createNode } from "@/features/graph/actions";
import { Canvas } from "@/features/canvas/Canvas";
import { NodePanel } from "@/features/panels/NodePanel";
import { ActivityPanel, ConflictPanel, EdgePanel, InboxPanel } from "@/features/panels/SidePanels";
import { GridView, ListView, TimelineView } from "@/features/views/Views";
import { CommandPalette } from "@/features/search/CommandPalette";
import { AddPageDialog, ExportDialog, ShareDialog, ShortcutsDialog, StopSessionDialog } from "./Dialogs";
import { syncCachedSession, useWorkspace } from "./useWorkspace";
import { GoalButton, GoalDialog } from "./Goal";
import { clearGoalAnswer, getGoalAnswer, saveGoalAnswer } from "./goalAnswer";
import { qk } from "@/features/workspaces/hooks";


/* ---------------------------------------------------------------- session controls (F4 / sessions) */

function useSessionControls(workspaceId: string) {
  const qc = useQueryClient();
  const session = useSessionStore((s) => s.session);
  const setSessionStore = useSessionStore((s) => s.setSession);
  const setSession = (s: Session | null) => {
    setSessionStore(s);
    syncCachedSession(qc, workspaceId, s);
  };
  const [busy, setBusy] = useState(false);
  const wrap = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      toast.apiError(e);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return {
    session,
    busy,
    start: (goal: string) =>
      wrap(async () => {
        const s = await sessionApi.start(workspaceId, goal);
        setSession(s);
        if (API_MODE === "mock") browsingSimulator.start(workspaceId, s.id);
        else extensionBridge.startTracking(workspaceId, s.id, true, s.goal);
        toast.success("Tracking started", {
          description: s.goal ? "We will tell you when a page is not part of your goal." : "Browse normally. Pages you read are added to your canvas.",
        });
        void qc.invalidateQueries({ queryKey: qk.sessions(workspaceId) });
      }),
    setGoal: (goal: string) =>
      wrap(async () => {
        if (!session) return;
        const s = await sessionApi.setGoal(session.id, goal);
        setSession(s);
        if (API_MODE !== "mock") extensionBridge.goalChanged(s.goal);
        toast.success(s.goal ? "Goal saved" : "Goal removed");
      }),
    pause: () =>
      wrap(async () => {
        if (!session) return;
        if (API_MODE === "mock") browsingSimulator.pause();
        else extensionBridge.pauseTracking();
        setSession(await sessionApi.pause(session.id));
        toast.info("Tracking paused");
      }),
    resume: () =>
      wrap(async () => {
        if (!session) return;
        setSession(await sessionApi.resume(session.id));
        if (API_MODE === "mock") browsingSimulator.resume();
        else extensionBridge.resumeTracking();
        toast.info("Tracking resumed");
      }),
    stop: async () =>
      (await wrap(async () => {
        if (!session) return null;
        const tabs = API_MODE === "mock" ? browsingSimulator.openTabs() : ((await extensionBridge.getOpenTabs()) ?? Object.keys(useExtensionStore.getState().tabs));
        browsingSimulator.stop();
        if (API_MODE !== "mock") extensionBridge.stopTracking();
        const s = await sessionApi.stop(session.id, tabs);
        setSession(null);
        toast.success("Tracking stopped", { description: `${s.title} saved` });
        void qc.invalidateQueries({ queryKey: qk.sessions(workspaceId) });
        return s.id;
      })) ?? null,
  };
}

/** A curved arrow under the Start Tracking button with a short label. It keeps nudging toward the button until the button is clicked. */
function StartArrow() {
  return (
    <span className="pointer-events-none absolute left-1/2 top-full z-40 -ml-6 mt-1 h-20 w-24" aria-hidden>
      <span className="absolute inset-0 animate-nudge text-ink">
        <svg viewBox="0 0 80 60" className="h-full w-full" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M70 56 C74 30 40 30 24 8" />
          <path d="M25 18 L24 8 L33 12" />
        </svg>
      </span>
      <span className="absolute left-12 top-[66px] whitespace-nowrap rounded-full bg-pill px-3 py-1 text-xs font-bold text-white shadow-pop">Start here</span>
    </span>
  );
}

function TrackingControl({ workspaceId, readOnly }: { workspaceId: string; readOnly: boolean }) {
  const c = useSessionControls(workspaceId);
  const dialog = useUiStore((st) => st.dialog);
  const goalDialog = dialog === "goal-ask" ? "ask" : dialog === "goal-start" ? "start" : dialog === "goal-edit" ? "edit" : null;
  const [answer, setAnswer] = useState<string | null>(() => getGoalAnswer(workspaceId)); // the saved answer to the goal question, until tracking starts
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = c.session;
  const emptyCanvas = useGraphStore((st) => st.nodes.length === 0); // nothing tracked yet: show the way to start
  const [needExtension, setNeedExtension] = useState(false);
  const [checking, setChecking] = useState(false);
  if (readOnly) return null;

  const answerQuestion = async (goal: string) => {
    saveGoalAnswer(workspaceId, goal);
    setAnswer(goal);
  };
  // The goal question is asked once, when the workspace is created. After that one click starts tracking.
  // Only a later session in a workspace that already has pages asks for the goal again.
  const startTracking = async () => {
    // Tracking needs the Chrome extension: without it no page could reach the canvas.
    if (API_MODE === "http") {
      setChecking(true);
      const ok = await connectExtension().catch(() => false);
      setChecking(false);
      if (!ok) return setNeedExtension(true);
    }
    if (answer === null && !emptyCanvas) return useUiStore.getState().setDialog("goal-start");
    if ((await c.start(answer ?? "")) !== null) {
      clearGoalAnswer(workspaceId);
      setAnswer(null);
    }
  };
  return (
    <>
      {!s ? (
        <span className="relative shrink-0">
          <Button variant="purple" size="sm" onClick={() => void startTracking()} loading={c.busy || checking} aria-label="Start tracking">
            {/* Phones: icon only, so the top bar fits 360px screens; tablets and up show the full label. */}
            <Record size={16} weight="fill" /> <span className="hidden sm:inline">Start Tracking</span>
          </Button>
          {(answer !== null || emptyCanvas) && <StartArrow />}
        </span>
      ) : (
        <div className={cn("flex shrink-0 items-center gap-1 rounded-full border border-line py-1 pl-2.5 pr-1 shadow-pop sm:pl-3", s.state === "paused" ? "bg-sun-soft" : "bg-coral-soft")} role="status" aria-live="polite">
          <span className={cn("h-2.5 w-2.5 rounded-full", s.state === "paused" ? "bg-warning" : "animate-pulse bg-danger")} />
          <span className="sr-only text-xs font-bold sm:not-sr-only">{s.state === "paused" ? "Paused" : "Tracking"}</span>
          <span className="tabular ml-1 hidden font-mono text-xs font-bold sm:inline">{formatClock(sessionElapsed(s))}</span>
          <Tip label={s.state === "paused" ? "Resume" : "Pause"}>
            <button aria-label={s.state === "paused" ? "Resume tracking" : "Pause tracking"} onClick={() => void (s.state === "paused" ? c.resume() : c.pause())} className="ml-1 grid h-7 w-7 place-items-center rounded-full bg-white hover:bg-canvas">
              {s.state === "paused" ? <Play size={13} weight="fill" /> : <Pause size={13} weight="fill" />}
            </button>
          </Tip>
          <Tip label="Stop tracking">
            <button aria-label="Stop tracking" onClick={() => useUiStore.getState().setDialog("stop-session")} className="grid h-7 w-7 place-items-center rounded-full bg-ink text-white hover:bg-danger">
              <Stop size={13} weight="fill" />
            </button>
          </Tip>
        </div>
      )}
      <GoalDialog
        open={goalDialog !== null}
        onOpenChange={(o) => {
          if (o) return;
          // Closing the question without an answer means "no goal": the arrow still points to Start Tracking.
          if (goalDialog === "ask" && getGoalAnswer(workspaceId) === null) void answerQuestion("");
          useUiStore.getState().setDialog(null);
        }}
        workspaceId={workspaceId}
        mode={goalDialog ?? "start"}
        initial={goalDialog === "edit" ? s?.goal : undefined}
        onSubmit={(goal) => (goalDialog === "ask" ? answerQuestion(goal) : goalDialog === "start" ? c.start(goal) : c.setGoal(goal))}
      />
      <StopSessionDialog workspaceId={workspaceId} sessionId={s?.id ?? null} onStop={c.stop} />
      <Modal
        open={needExtension}
        onOpenChange={setNeedExtension}
        size="sm"
        title="Install the Chrome extension first"
        description="Tracking needs the Research Map extension. You install it once."
        footer={
          <>
            <Button variant="ghost" onClick={() => setNeedExtension(false)}>Not now</Button>
            <Link href={`/extension?next=${encodeURIComponent(`/w/${workspaceId}`)}`}>
              <Button variant="primary">See the install steps</Button>
            </Link>
          </>
        }
      >
        <ol className="space-y-1.5 text-sm text-ink-soft">
          <li>1. Download and unzip it.</li>
          <li>2. Open chrome://extensions and turn on Developer mode.</li>
          <li>3. Click Load unpacked and choose the folder.</li>
        </ol>
        <a href={EXTENSION_ZIP} download className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-purple-deep hover:underline">
          <DownloadSimple size={16} weight="bold" /> Download extension
        </a>
      </Modal>
    </>
  );
}

/** Tells a person who opened a shared link what they can do here. */
function ViewerNotice() {
  const owner = useGraphStore((s) => s.workspace?.members.find((m) => m.role === "owner")?.name);
  return (
    <p className="shrink-0 border-b border-ink/5 bg-sky-soft px-4 py-1.5 text-center text-xs font-semibold text-sky-deep" role="status">
      {owner ? `${owner} shared this workspace with you.` : "This workspace was shared with you."} You can look around and read every page, but you cannot change anything.
    </p>
  );
}

/* ---------------------------------------------------------------- top bar */

// Three ways to look at the map. Focus is switched on the canvas itself; cards (grid) are in the More menu.
const VIEWS: { value: ViewMode; label: string; icon: typeof FrameCorners }[] = [
  { value: "graph", label: "Canvas", icon: FrameCorners },
  { value: "list", label: "List", icon: ListBullets },
  { value: "timeline", label: "Timeline", icon: ClockCounterClockwise },
];

function WorkspaceTitle({ readOnly }: { readOnly: boolean }) {
  const ws = useGraphStore((s) => s.workspace);
  const [edit, setEdit] = useState<string | null>(null);
  const qc = useQueryClient();
  if (!ws) return null;
  return edit !== null ? (
    <input
      autoFocus
      aria-label="Workspace name"
      className="h-9 w-full min-w-0 rounded-full border-2 border-purple bg-white px-3 font-display text-sm font-bold outline-none sm:w-56"
      value={edit}
      onChange={(e) => setEdit(e.target.value)}
      onBlur={async () => {
        const v = edit.trim();
        setEdit(null);
        if (!v || v === ws.title) return;
        try {
          const w = await workspaceApi.update(ws.id, { title: v });
          useGraphStore.getState().setWorkspace({ ...ws, title: w.title });
          void qc.invalidateQueries({ queryKey: qk.workspaces });
          toast.success("Workspace renamed");
        } catch (e) {
          toast.apiError(e);
        }
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  ) : (
    <button onDoubleClick={() => !readOnly && setEdit(ws.title)} title={readOnly ? ws.title : "Double-click to rename"} className="min-w-0 truncate text-left font-display text-[15px] font-bold tracking-tight">
      {ws.title}
    </button>
  );
}

function SocketBadge() {
  const status = useCollabStore((s) => s.socketStatus);
  if (status === "open") return null; // only worth showing when something is wrong
  return (
    <span role="status" className="flex items-center gap-1 rounded-full bg-warning-soft px-2 py-1 text-[11px] font-bold text-warning">
      <WifiSlash size={14} weight="bold" /> {status === "connecting" ? "Connecting…" : status === "reconnecting" ? "Connection lost · retrying" : "Offline"}
    </span>
  );
}

function TopBar({ workspaceId, readOnly }: { workspaceId: string; readOnly: boolean }) {
  const viewMode = useUiStore((s) => s.viewMode);
  const presence = useCollabStore((s) => s.presence);
  const members = useGraphStore((s) => s.workspace?.members.length ?? 1);
  const conflicts = useSignalsStore((s) => s.conflicts.filter((c) => c.status === "open").length);
  const router = useRouter();
  const lastSession = useSessionStore((s) => s.session);
  // Branches and live presence only matter when other people work in this workspace.
  const shared = members > 1 || presence.length > 1;
  const panel = (p: Exclude<PanelKind, null>) => () => useUiStore.getState().togglePanel(p);

  return (
    <header className="z-30 flex h-14 w-full shrink-0 items-center justify-between gap-2 border-b border-ink/5 bg-white/60 backdrop-blur-md px-3 backdrop-blur-md sm:px-4">
      {/* Left: where am I + tracking. May shrink (the title truncates) so the right side always stays on screen. */}
      <div className="flex min-w-0 items-center gap-2">
        <Link href="/workspaces" aria-label="Back to workspaces" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white shadow-clay-sm hover:-translate-y-0.5 transition">
          <ArrowLeft size={16} weight="bold" />
        </Link>
        <div className="flex min-w-0 max-w-[140px] items-center gap-1.5 sm:max-w-[200px] md:max-w-[240px]">
          <WorkspaceTitle readOnly={readOnly} />
        </div>
        <TrackingControl workspaceId={workspaceId} readOnly={readOnly} />
        {!readOnly && lastSession && <GoalButton session={lastSession} onEdit={() => useUiStore.getState().setDialog("goal-edit")} />}
      </div>

      {/* Center: how to look at the map */}
      <div className="hidden lg:flex shrink-0 items-center justify-center">
        <Segmented layoutId="view-pill" size="xs" value={viewMode === "focus" ? "graph" : viewMode} onChange={(v) => useUiStore.getState().setViewMode(v)} options={VIEWS} />
      </div>

      {/* Right: search, share, account, everything else in More */}
      <div className="flex shrink-0 items-center gap-1.5">
        <Tip label="Search (Ctrl+K)">
          <Button size="icon-sm" variant="secondary" aria-label="Search" onClick={() => useUiStore.getState().setSearchOpen(true)}><MagnifyingGlass size={16} weight="bold" /></Button>
        </Tip>

        {shared && (
          <div className="hidden xl:flex">
            <AvatarStack people={presence.map((p) => ({ name: p.name, color: p.color, online: true }))} size={28} max={3} />
          </div>
        )}
        <SocketBadge />

        {!readOnly && (
          <Button size="sm" variant="outline" className="hidden sm:inline-flex shadow-clay-sm" onClick={() => useUiStore.getState().setDialog("share")}>
            <ShareNetwork size={15} weight="bold" /> Share
          </Button>
        )}

        <UserMenu />

        <Menu>
          <MenuTrigger asChild>
            <Button size="icon-sm" variant="secondary" aria-label={conflicts ? "More actions (new conflicts to review)" : "More actions"} className="relative">
              <DotsThreeOutline size={16} weight="fill" />
              {conflicts > 0 && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-coral" aria-hidden />}
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuLabel>Insights</MenuLabel>
            <MenuItem onSelect={panel("conflicts")}><Sword size={17} weight="bold" /> Conflict Radar{conflicts ? ` (${conflicts})` : ""}</MenuItem>
            <MenuItem onSelect={async () => {
              const list = await sessionApi.list(workspaceId).catch(() => []);
              const id = lastSession?.id ?? list[0]?.id;
              if (id) router.push(`/w/${workspaceId}/report/${id}`);
              else toast.info("No sessions yet", { description: "Start Tracking to record a session first." });
            }}><ChartBar size={17} weight="bold" /> Session report</MenuItem>
            <MenuSeparator />
            {!readOnly && <MenuItem onSelect={() => useUiStore.getState().setDialog("share")}><ShareNetwork size={17} weight="bold" /> Share…</MenuItem>}
            <MenuItem onSelect={() => useUiStore.getState().setDialog("export")}><Export size={17} weight="bold" /> Export…</MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => useUiStore.getState().setDialog("shortcuts")}><Keyboard size={17} weight="bold" /> Keyboard shortcuts</MenuItem>
            <MenuItem onSelect={() => router.push("/settings")}><Robot size={17} weight="bold" /> Extension & MCP settings</MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
}

/* ---------------------------------------------------------------- floating canvas toolbar */

function AddButton({ readOnly }: { readOnly: boolean }) {
  const rf = useReactFlow();
  if (readOnly) return null;
  const center = () => {
    const el = document.querySelector(".react-flow")!.getBoundingClientRect();
    return rf.screenToFlowPosition({ x: el.left + el.width / 2 - 120, y: el.top + el.height / 2 - 60 });
  };
  return (
    <div className="absolute left-4 top-4 z-10">
      <Menu>
        <MenuTrigger asChild>
          <button aria-label="Add" className="grid h-11 w-11 place-items-center rounded-full bg-purple text-white shadow-clay-sm"><Plus size={20} weight="bold" /></button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem onSelect={() => useUiStore.getState().setDialog("add-page")}><LinkSimple size={17} weight="bold" /> Page (URL)…</MenuItem>
          <MenuItem onSelect={() => void createNode("note", center())}><NotePencil size={17} weight="bold" /> Note</MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

/* ---------------------------------------------------------------- panel drawer */

const PANEL_TITLE: Record<Exclude<PanelKind, null>, string> = {
  node: "Details",
  edge: "Why are these connected?",
  radar: "Research Radar",
  conflicts: "Conflict Radar",
  memory: "Research Memory",
  branches: "Branches",
  inbox: "Inbox",
  activity: "AI activity",
};

function PanelDrawer({ workspaceId, readOnly }: { workspaceId: string; readOnly: boolean }) {
  const panel = useUiStore((s) => s.panel);
  const nodeId = useUiStore((s) => s.selectedNodeId);
  const edgeId = useUiStore((s) => s.selectedEdgeId);
  const show = panel && !(panel === "node" && !nodeId) && !(panel === "edge" && !edgeId);
  return (
    <AnimatePresence>
      {show && (
        <motion.aside
          key="panel"
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 40, opacity: 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 32 }}
          className="absolute inset-x-2 bottom-2 top-auto z-20 flex max-h-[70dvh] flex-col rounded-[28px] border border-line bg-canvas shadow-pop-lg md:inset-x-auto md:bottom-3 md:right-3 md:top-3 md:max-h-none md:w-[400px]"
          aria-label={PANEL_TITLE[panel!]}
        >
          <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-4">
            <h2 className="font-display text-base font-bold">{PANEL_TITLE[panel!]}</h2>
            <button aria-label="Close panel" onClick={() => { useUiStore.getState().openPanel(null); }} className="grid h-9 w-9 place-items-center rounded-full bg-white shadow-clay-sm transition hover:rotate-90"><X size={16} weight="bold" /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {panel === "node" && nodeId && <NodePanel key={nodeId} nodeId={nodeId} readOnly={readOnly} />}
            {panel === "edge" && edgeId && <EdgePanel key={edgeId} edgeId={edgeId} readOnly={readOnly} />}
            {panel === "conflicts" && <ConflictPanel workspaceId={workspaceId} readOnly={readOnly} />}
            {panel === "activity" && <ActivityPanel />}
            {panel === "inbox" && <InboxPanel readOnly={readOnly} />}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/* ---------------------------------------------------------------- keyboard shortcuts */

function useShortcuts(readOnly: boolean) {
  const rf = useReactFlow();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true], [role=dialog]") || e.ctrlKey || e.metaKey || e.altKey) return;
      const ui = useUiStore.getState();
      const views: Record<string, ViewMode> = { "1": "graph", "2": "list", "3": "timeline" };
      if (views[e.key]) ui.setViewMode(views[e.key]!);
      else if (e.key === "Escape") { ui.openPanel(null); ui.selectNode(null, false); }
      else if (e.key === "?") ui.setDialog("shortcuts");
      else if (e.key.toLowerCase() === "c") ui.togglePanel("conflicts");
      else if (e.key.toLowerCase() === "n" && !readOnly && ui.viewMode === "graph") {
        const el = document.querySelector(".react-flow")?.getBoundingClientRect();
        if (el) void createNode("note", rf.screenToFlowPosition({ x: el.left + el.width / 2, y: el.top + el.height / 2 }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rf, readOnly]);
}

/* ---------------------------------------------------------------- screen */

function Inner({ workspaceId }: { workspaceId: string }) {
  const graph = useWorkspace(workspaceId);
  const viewMode = useUiStore((s) => s.viewMode);
  const role = useGraphStore((s) => s.workspace?.my_role);
  const loaded = useGraphStore((s) => s.loaded);
  const empty = useGraphStore((s) => s.nodes.length === 0);
  const tracking = useSessionStore((s) => !!s.session);
  const readOnly = role === "viewer";
  useShortcuts(readOnly);

  if (graph.error && !loaded)
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        <ErrorState error={graph.error} title={(graph.error as { code?: string }).code === "not_found" ? "Workspace not found" : undefined} onRetry={() => void graph.refetch()} />
        <div className="mt-4 text-center"><Link href="/workspaces" className="text-sm font-bold text-purple-deep">← Back to workspaces</Link></div>
      </div>
    );
  if (!loaded) return <LoadingBlock label="Loading graph…" className="h-dvh" />;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-app">
      <TopBar workspaceId={workspaceId} readOnly={readOnly} />
      {readOnly && <ViewerNotice />}
      <div className="lg:hidden shrink-0 border-b border-ink/5 bg-white/60 px-3 py-1.5">
        <Segmented layoutId="view-pill-m" size="xs" value={viewMode === "focus" ? "graph" : viewMode} onChange={(v) => useUiStore.getState().setViewMode(v)} options={VIEWS} className="scrollbar-none w-full justify-between overflow-x-auto [&_svg]:hidden min-[420px]:[&_svg]:inline" />
      </div>
      <main className="relative min-h-0 flex-1">
        {(viewMode === "graph" || viewMode === "focus") && (
          <>
            <Canvas readOnly={readOnly} />
            <AddButton readOnly={readOnly} />
            {empty && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
                <div className="pointer-events-auto max-w-md">
                  <EmptyState
                    icon={Browsers}
                    title={tracking ? "Waiting for your first page" : "Start tracking, then open web pages"}
                    message={tracking ? "Each page you read for your goal appears here a few seconds after you open it." : "Each page you read appears here, connected to the pages it relates to."}
                    action={!readOnly && !tracking ? <Button variant="secondary" onClick={() => useUiStore.getState().setDialog("add-page")}><Plus size={16} weight="bold" /> Add a page manually</Button> : undefined}
                  />
                </div>
              </div>
            )}
          </>
        )}
        {viewMode === "list" && <ListView />}
        {viewMode === "grid" && <GridView />}
        {viewMode === "timeline" && <TimelineView workspaceId={workspaceId} />}
        <PanelDrawer workspaceId={workspaceId} readOnly={readOnly} />
      </main>
      <CommandPalette workspaceId={workspaceId} />
      <ShareDialog workspaceId={workspaceId} isOwner={role === "owner"} />
      <ExportDialog workspaceId={workspaceId} />
      <AddPageDialog workspaceId={workspaceId} />
      <ShortcutsDialog />
    </div>
  );
}

export function WorkspaceScreen({ workspaceId }: { workspaceId: string }) {
  return (
    <ReactFlowProvider>
      <Inner workspaceId={workspaceId} />
    </ReactFlowProvider>
  );
}
