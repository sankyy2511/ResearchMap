"use client";
/**
 * GRAPH STATE — React Flow nodes/edges + normalized side data (pages, tags, annotations…).
 * Server data arrives from GET /graph and WebSocket messages (applyMessage).
 */
import { create } from "zustand";
import { applyEdgeChanges, applyNodeChanges, type Edge, type EdgeChange, type Node, type NodeChange } from "@xyflow/react";
import type {
  Annotation,
  Branch,
  Category,
  GraphResponse,
  Page,
  ResearchEdge,
  ResearchNode,
  Tag,
  Workspace,
  WsServerMessage,
} from "@/types/api";
import { TOPIC_COLLAPSED } from "@/lib/graph/layout";

/** note: a short grey label shown on pages outside the goal ("Not related to your goal"). order: 1, 2, 3 … in the order pages were opened. */
export type RFNode = Node<{ node: ResearchNode; note?: string; order?: number }>;
export type RFEdge = Edge<{ edge: ResearchEdge }>;

export function toRFNode(n: ResearchNode, parentCollapsed = false): RFNode {
  const isTopic = n.type === "topic";
  return {
    id: n.id,
    type: n.type,
    position: { x: n.x, y: n.y },
    parentId: n.parent_id ?? undefined,
    data: { node: n },
    hidden: parentCollapsed,
    zIndex: isTopic ? -1 : 1,
    ...(isTopic
      ? {
          width: n.collapsed ? TOPIC_COLLAPSED.w : (n.width ?? 560),
          height: n.collapsed ? TOPIC_COLLAPSED.h : (n.height ?? 320),
          style: {
            width: n.collapsed ? TOPIC_COLLAPSED.w : (n.width ?? 560),
            height: n.collapsed ? TOPIC_COLLAPSED.h : (n.height ?? 320),
          },
        }
      : {}),
  };
}

export function toRFEdge(e: ResearchEdge): RFEdge {
  return {
    id: e.id,
    source: e.source_id,
    target: e.target_id,
    type: "explained",
    data: { edge: e },
    hidden: e.state === "rejected" || (e.state === "suggested" && (e.confidence ?? 1) < 0.5),
  };
}

/** Parents must precede children in React Flow's array. */
function sortNodes(nodes: RFNode[]): RFNode[] {
  return [...nodes].sort((a, b) => (a.type === "topic" ? 0 : 1) - (b.type === "topic" ? 0 : 1));
}

interface GraphState {
  workspaceId: string | null;
  workspace: Workspace | null;
  loaded: boolean;
  nodes: RFNode[];
  edges: RFEdge[];
  pages: Record<string, Page>;
  tags: Tag[];
  categories: Category[];
  annotations: Record<string, Annotation>;
  branches: Branch[];
  /** node ids to flash (search jump) */
  flashId: string | null;
  hydrate: (g: GraphResponse) => void;
  reset: () => void;
  onNodesChange: (changes: NodeChange<RFNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<RFEdge>[]) => void;
  upsertNode: (n: ResearchNode) => void;
  removeNode: (id: string) => void;
  upsertEdge: (e: ResearchEdge) => void;
  removeEdge: (id: string) => void;
  upsertPage: (p: Page) => void;
  upsertAnnotation: (a: Annotation) => void;
  removeAnnotation: (id: string) => void;
  setTags: (t: Tag[]) => void;
  setCategories: (c: Category[]) => void;
  setWorkspace: (w: Workspace) => void;
  setFlash: (id: string | null) => void;
  moveNodeLive: (id: string, x: number, y: number) => void;
  applyMessage: (msg: WsServerMessage) => void;
}

const empty = {
  workspaceId: null,
  workspace: null,
  loaded: false,
  nodes: [] as RFNode[],
  edges: [] as RFEdge[],
  pages: {} as Record<string, Page>,
  tags: [] as Tag[],
  categories: [] as Category[],
  annotations: {} as Record<string, Annotation>,
  branches: [] as Branch[],
  flashId: null,
};

function withCollapse(nodes: RFNode[]): RFNode[] {
  const collapsed = new Set(nodes.filter((n) => n.type === "topic" && n.data.node.collapsed).map((n) => n.id));
  return nodes.map((n) => {
    const shouldHide = !!n.parentId && collapsed.has(n.parentId);
    return n.hidden === shouldHide ? n : { ...n, hidden: shouldHide };
  });
}

export const useGraphStore = create<GraphState>((set, get) => ({
  ...empty,
  hydrate: (g) =>
    set({
      workspaceId: g.workspace.id,
      workspace: g.workspace,
      loaded: true,
      nodes: withCollapse(sortNodes(g.nodes.map((n) => toRFNode(n)))),
      edges: g.edges.map(toRFEdge),
      pages: Object.fromEntries(g.pages.map((p) => [p.id, p])),
      tags: g.tags,
      categories: g.categories,
      annotations: Object.fromEntries(g.annotations.map((a) => [a.id, a])),
      branches: g.branches,
    }),
  reset: () => set({ ...empty }),
  onNodesChange: (changes) => set({ nodes: applyNodeChanges(changes, get().nodes) }),
  onEdgesChange: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),
  upsertNode: (n) =>
    set((s) => {
      const i = s.nodes.findIndex((x) => x.id === n.id);
      const prev = i >= 0 ? s.nodes[i] : undefined;
      const next = toRFNode(n);
      if (prev) {
        next.selected = prev.selected;
        next.dragging = prev.dragging;
        // don't yank a node the user is dragging right now
        if (prev.dragging) next.position = prev.position;
        if (prev.measured) next.measured = prev.measured;
      }
      const nodes = i >= 0 ? s.nodes.map((x, j) => (j === i ? next : x)) : [...s.nodes, next];
      const needsSort = !prev || prev.parentId !== next.parentId || n.type === "topic";
      return { nodes: withCollapse(needsSort ? sortNodes(nodes) : nodes) };
    }),
  removeNode: (id) =>
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      edges: s.edges.filter((e) => e.source !== id && e.target !== id),
    })),
  upsertEdge: (e) =>
    set((s) => {
      const i = s.edges.findIndex((x) => x.id === e.id);
      const next = toRFEdge(e);
      if (i >= 0) next.selected = s.edges[i]!.selected;
      return { edges: i >= 0 ? s.edges.map((x, j) => (j === i ? next : x)) : [...s.edges, next] };
    }),
  removeEdge: (id) => set((s) => ({ edges: s.edges.filter((e) => e.id !== id) })),
  upsertPage: (p) => set((s) => ({ pages: { ...s.pages, [p.id]: p } })),
  upsertAnnotation: (a) => set((s) => ({ annotations: { ...s.annotations, [a.id]: a } })),
  removeAnnotation: (id) =>
    set((s) => {
      const next = { ...s.annotations };
      delete next[id];
      Object.values(next).forEach((a) => a.parent_id === id && delete next[a.id]);
      return { annotations: next };
    }),
  setTags: (tags) => set({ tags }),
  setCategories: (categories) => set({ categories }),
  setWorkspace: (workspace) => set({ workspace }),
  setFlash: (flashId) => set({ flashId }),
  moveNodeLive: (id, x, y) =>
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id && !n.dragging ? { ...n, position: { x, y } } : n)) })),
  applyMessage: (msg) => {
    const s = get();
    if (msg.workspace_id !== s.workspaceId) return;
    switch (msg.type) {
      case "node.created":
      case "node.updated":
        return s.upsertNode(msg.data);
      case "node.deleted":
        return s.removeNode(msg.data.id);
      case "edge.created":
      case "edge.updated":
        return s.upsertEdge(msg.data);
      case "edge.deleted":
        return s.removeEdge(msg.data.id);
      case "annotation.created":
      case "annotation.updated":
        return s.upsertAnnotation(msg.data);
      case "annotation.deleted":
        return s.removeAnnotation(msg.data.id);
      case "page.analyzed":
      case "page.created":
        return s.upsertPage(msg.data);
      case "preview.updated": {
        // New server snapshot: bump preview_captured_at so the preview refetches it (instead of the og:image fallback).
        const p = s.pages[msg.data.page_id];
        return p ? s.upsertPage({ ...p, preview_captured_at: msg.data.captured_at }) : undefined;
      }
      case "tags.updated":
        return s.setTags(msg.data);
      case "categories.updated":
        return s.setCategories(msg.data);
      case "node.moving":
        return s.moveNodeLive(msg.data.id, msg.data.x, msg.data.y);
      case "graph.reorganized": {
        msg.data.topics.forEach((t) => get().upsertNode(t));
        const changes = new Map(msg.data.parent_changes.map((c) => [c.id, c]));
        set((st) => ({
          nodes: withCollapse(
            sortNodes(
              st.nodes
                .filter((n) => n.type !== "topic" || msg.data.topics.some((t) => t.id === n.id))
                .map((n) => {
                  const c = changes.get(n.id);
                  if (!c) return n;
                  const node = { ...n.data.node, parent_id: c.parent_id, x: c.x, y: c.y };
                  return { ...toRFNode(node), selected: n.selected, measured: n.measured };
                }),
            ),
          ),
        }));
        return;
      }
      default:
        return;
    }
  },
}));

/* ---------------------------------------------------------------- selectors */

export const selectNode = (id: string | null) => (s: GraphState) =>
  id ? (s.nodes.find((n) => n.id === id)?.data.node ?? null) : null;
export const selectEdge = (id: string | null) => (s: GraphState) =>
  id ? (s.edges.find((e) => e.id === id)?.data?.edge ?? null) : null;

export function getNode(id: string): ResearchNode | null {
  return useGraphStore.getState().nodes.find((n) => n.id === id)?.data.node ?? null;
}
export function allResearchNodes(): ResearchNode[] {
  return useGraphStore.getState().nodes.map((n) => n.data.node);
}
