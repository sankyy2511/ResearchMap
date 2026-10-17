"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanOnScrollMode, ReactFlow, useReactFlow, useStoreApi, type OnBeforeDelete, type Viewport } from "@xyflow/react";
import { ArrowSquareOut, CornersOut, Crosshair, Minus, NotePencil, Plus, Trash } from "@phosphor-icons/react";
import type { NodeType } from "@/types/api";
import { extensionBridge } from "@/lib/extension/bridge";
import { cn } from "@/lib/utils/cn";
import { useQuery } from "@tanstack/react-query";
import { sessionApi } from "@/lib/api";
import { normalizeUrl } from "@/lib/utils/url";
import { useGraphStore, type RFEdge, type RFNode } from "@/stores/graph";
import { useSessionStore } from "@/stores/session";
import { useUiStore } from "@/stores/ui";
import { Tip } from "@/components/ui/primitives";
import { createNode, deleteEdge, deleteNodes, rejectEdge } from "@/features/graph/actions";
import { nodeTypes } from "./nodes";
import { buildBrowsingTree } from "./browsingTree";

/** The canvas shows the path you took through the web (see browsingTree.ts). A page that is not related to the goal gets a small label. */
function useVisibleGraph() {
  const nodes = useGraphStore((s) => s.nodes);
  const pages = useGraphStore((s) => s.pages);
  const session = useSessionStore((s) => s.session);
  const checks = useQuery({ queryKey: ["goal-checks", session?.id], queryFn: () => sessionApi.goalChecks(session!.id), enabled: !!session?.goal });
  return useMemo(() => {
    const onGoal = new Map((checks.data ?? []).map((c) => [normalizeUrl(c.url), c.on_goal]));
    // The only label on a page: it is not related to the goal. Without a goal there are no labels.
    const noteFor = (n: RFNode) => {
      const page = n.data.node.page_id ? pages[n.data.node.page_id] : undefined;
      return page && onGoal.get(normalizeUrl(page.url)) === false ? "Not related to your goal" : undefined;
    };
    return buildBrowsingTree(nodes, noteFor);
  }, [nodes, pages, checks.data]);
}

interface Ctx {
  x: number;
  y: number;
  flow: { x: number; y: number };
  nodeId?: string;
}

export function Canvas({ readOnly }: { readOnly: boolean }) {
  const rf = useReactFlow();
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const { nodes, edges } = useVisibleGraph();
  const focusRequest = useUiStore((s) => s.focusRequest);
  const selectNode = useUiStore((s) => s.selectNode);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  // Read the saved view once: subscribing to it would redraw the whole map after every zoom or move.
  const [savedView] = useState(() => useUiStore.getState().viewport);
  const hadSavedView = savedView.x !== 0 || savedView.y !== 0;

  // Show the whole tree when it opens and whenever a page is added or removed.
  const count = nodes.length;
  useEffect(() => {
    if (!count) return;
    const t = setTimeout(() => void rf.fitView({ duration: 400, padding: 0.2, maxZoom: 1 }), 200);
    return () => clearTimeout(t);
  }, [count, rf]);

  // The dot grid moves with the map when you drag, but keeps its size when you zoom: zooming never draws more dots.
  const flow = useStoreApi();
  useEffect(
    () =>
      flow.subscribe((st) => {
        if (wrapper.current) wrapper.current.style.backgroundPosition = `${st.transform[0]}px ${st.transform[1]}px`;
      }),
    [flow],
  );

  // Pinch zoom (and Ctrl + wheel) at the same speed on every system. React Flow makes it 10x faster only on
  // macOS, so on Windows touchpads it felt very slow.
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // plain scrolling moves the map
      e.preventDefault(); // also stops the browser from zooming the whole page
      e.stopPropagation();
      const step = Math.max(-0.5, Math.min(0.5, -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.02)));
      const { x, y, zoom } = rf.getViewport();
      const next = Math.max(0.08, Math.min(2, zoom * 2 ** step));
      const box = el.getBoundingClientRect();
      const px = e.clientX - box.left;
      const py = e.clientY - box.top;
      void rf.setViewport({ x: px - ((px - x) * next) / zoom, y: py - ((py - y) * next) / zoom, zoom: next }); // keep the point under the fingers still
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [rf]);

  // A broken view (NaN) would draw nothing at all, so go back to the last good one.
  const goodView = useRef(savedView);
  const keepViewValid = (v: Viewport) => {
    if ([v.x, v.y, v.zoom].every(Number.isFinite)) goodView.current = v;
    else void rf.setViewport(goodView.current);
  };

  // Zoom-to-node requests (search results, references, radar…)
  useEffect(() => {
    if (!focusRequest) return;
    const n = rf.getNode(focusRequest.id);
    if (!n) return;
    const w = n.measured?.width ?? 300;
    const h = n.measured?.height ?? 230;
    void rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: 1.05, duration: 700 });
    useGraphStore.getState().setFlash(n.id);
    const t = setTimeout(() => useGraphStore.getState().setFlash(null), 2900);
    return () => clearTimeout(t);
  }, [focusRequest, rf]);

  const onBeforeDelete: OnBeforeDelete<RFNode, RFEdge> = useCallback(
    async ({ nodes: ns, edges: es }) => {
      if (readOnly) return false;
      if (ns.length) void deleteNodes(ns.map((n) => n.id));
      else
        es.forEach((e) => {
          const ed = e.data?.edge;
          if (!ed) return;
          if (ed.origin === "user") void deleteEdge(ed.id);
          else void rejectEdge(ed.id);
        });
      return false;
    },
    [readOnly],
  );

  const openCtx = (e: React.MouseEvent | MouseEvent, nodeId?: string) => {
    e.preventDefault();
    const rect = wrapper.current!.getBoundingClientRect();
    setCtx({
      x: Math.min(e.clientX - rect.left, rect.width - 230),
      y: Math.min(e.clientY - rect.top, rect.height - 260),
      flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
      nodeId,
    });
  };

  const ctxNode = ctx?.nodeId ? useGraphStore.getState().nodes.find((n) => n.id === ctx.nodeId)?.data.node : undefined;
  const ctxPage = ctxNode?.page_id ? useGraphStore.getState().pages[ctxNode.page_id] : undefined;

  const addAt = (type: NodeType) => {
    if (!ctx) return;
    void createNode(type, ctx.flow);
    setCtx(null);
  };

  return (
    <div
      ref={wrapper}
      className="bg-dots relative h-full w-full [&_.react-flow__pane]:cursor-grab [&_.react-flow__pane.dragging]:cursor-grabbing"
      onClick={() => ctx && setCtx(null)}
      onDoubleClick={(e) => {
        if (readOnly || !(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
        void createNode("note", rf.screenToFlowPosition({ x: e.clientX - 110, y: e.clientY - 40 }));
      }}
    >
      <ReactFlow<RFNode, RFEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onBeforeDelete={onBeforeDelete}
        onNodeClick={(_, n) => n.type !== "cluster" && selectNode(n.id)}
        onPaneClick={() => {
          selectNode(null, false);
        }}
        onNodeContextMenu={(e, n) => (n.type === "cluster" ? !readOnly && openCtx(e) : openCtx(e, n.id))}
        onPaneContextMenu={(e) => !readOnly && openCtx(e)}
        onMove={(_, v) => keepViewValid(v)}
        onMoveEnd={(_, v) => [v.x, v.y, v.zoom].every(Number.isFinite) && useUiStore.getState().setViewport(v)}
        defaultViewport={savedView}
        fitView={!hadSavedView}
        fitViewOptions={{ padding: 0.15, maxZoom: 0.9 }}
        minZoom={0.08}
        maxZoom={2}
        onlyRenderVisibleElements={nodes.length > 250}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnDrag
        panOnScroll
        panOnScrollSpeed={1.6}
        panOnScrollMode={PanOnScrollMode.Free}
        zoomActivationKeyCode={["Control", "Meta"]}
        panActivationKeyCode="Space"
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        selectionOnDrag={false}
        selectionKeyCode="Shift"
        elementsSelectable
        edgesFocusable
        multiSelectionKeyCode="Shift"
        deleteKeyCode={readOnly ? null : ["Delete", "Backspace"]}
        proOptions={{ hideAttribution: true }}
        className="bg-transparent"
      />
      <ZoomControls />

      {ctx && (
        <div
          role="menu"
          className="absolute z-50 w-56 rounded-[20px] border border-line bg-white p-1.5 shadow-pop-lg"
          style={{ left: Math.max(8, ctx.x), top: Math.max(8, ctx.y) }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxNode ? (
            <>
              <p className="truncate px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-faint">{ctxNode.title}</p>
              <CtxItem icon={Crosshair} label="Open details" onClick={() => { selectNode(ctxNode.id); setCtx(null); }} />
              {ctxPage && <CtxItem icon={ArrowSquareOut} label="Open page" onClick={() => { extensionBridge.openUrl(ctxPage.url); setCtx(null); }} />}
              {!readOnly && <CtxItem icon={NotePencil} label="Add note" onClick={() => { selectNode(ctxNode.id); useUiStore.setState({ panel: "node" }); setCtx(null); setTimeout(() => document.getElementById("panel-tab-notes")?.click(), 50); }} />}
              {!readOnly && <CtxItem icon={Trash} label="Delete" danger onClick={() => { void deleteNodes([ctxNode.id]); setCtx(null); }} />}
            </>
          ) : (
            <>
              <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-faint">Add here</p>
              <CtxItem icon={NotePencil} label="Note" onClick={() => addAt("note")} />
            </>
          )}
        </div>
      )}

    </div>
  );
}

function CtxItem({ icon: I, label, onClick, danger }: { icon: typeof Plus; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button role="menuitem" onClick={onClick} className={cn("flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-semibold hover:bg-canvas", danger ? "text-danger" : "text-ink")}>
      <I size={17} weight="bold" /> {label}
    </button>
  );
}

function ZoomControls() {
  const rf = useReactFlow();
  const btn = "grid h-9 w-9 place-items-center rounded-full hover:bg-canvas";
  return (
    <div className="absolute bottom-4 right-4 z-10 flex items-center gap-0.5 rounded-full border border-line bg-white p-1 shadow-soft" role="group" aria-label="Zoom">
      <Tip label="Zoom out">
        <button aria-label="Zoom out" onClick={() => rf.zoomOut({ duration: 200 })} className={btn}><Minus size={16} weight="bold" /></button>
      </Tip>
      <Tip label="Show everything">
        <button aria-label="Show everything" onClick={() => rf.fitView({ duration: 400, padding: 0.2, maxZoom: 1 })} className={btn}><CornersOut size={16} weight="bold" /></button>
      </Tip>
      <Tip label="Zoom in">
        <button aria-label="Zoom in" onClick={() => rf.zoomIn({ duration: 200 })} className={btn}><Plus size={16} weight="bold" /></button>
      </Tip>
    </div>
  );
}
