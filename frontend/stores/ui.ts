"use client";
/** UI STATE — the "resume exactly" view state (§F3) + transient UI flags. */
import { create } from "zustand";
import type { BranchView, ColorBy, GraphFilters, PanelKind, ViewMode, ViewState } from "@/types/api";

export const DEFAULT_FILTERS: GraphFilters = {
  tag_ids: [],
  category_ids: [],
  domains: [],
  page_types: [],
  collaborator_ids: [],
  show_suggested: true,
  show_weak: false,
};

export type DialogKind =
  | "share"
  | "export"
  | "compare"
  | "shortcuts"
  | "add-page"
  | "stop-session"
  | "goal-ask"
  | "goal-start"
  | "goal-edit"
  | "import"
  | null;

interface UiState {
  viewMode: ViewMode;
  panel: PanelKind;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  focusNodeId: string | null;
  branch: BranchView;
  filters: GraphFilters;
  colorBy: ColorBy;
  viewport: { x: number; y: number; zoom: number };
  searchOpen: boolean;
  dialog: DialogKind;
  journeyOverlay: boolean;
  /** Pending "zoom to node" request consumed by the canvas. */
  focusRequest: { id: string; at: number } | null;

  setViewMode: (m: ViewMode) => void;
  openPanel: (p: PanelKind) => void;
  togglePanel: (p: Exclude<PanelKind, null>) => void;
  selectNode: (id: string | null, openPanel?: boolean) => void;
  selectEdge: (id: string | null) => void;
  setFocusNode: (id: string | null) => void;
  setBranch: (b: BranchView) => void;
  setFilters: (f: Partial<GraphFilters>) => void;
  clearFilters: () => void;
  setColorBy: (c: ColorBy) => void;
  setViewport: (v: { x: number; y: number; zoom: number }) => void;
  setSearchOpen: (o: boolean) => void;
  setDialog: (d: DialogKind) => void;
  toggleJourney: () => void;
  requestFocus: (id: string) => void;
  restore: (v: ViewState | null) => void;
  snapshot: () => ViewState;
  reset: () => void;
}

const initial = {
  viewMode: "graph" as ViewMode,
  panel: null as PanelKind,
  selectedNodeId: null,
  selectedEdgeId: null,
  focusNodeId: null,
  branch: "main,mine" as BranchView,
  filters: DEFAULT_FILTERS,
  colorBy: "topic" as ColorBy,
  viewport: { x: 0, y: 0, zoom: 0.6 },
  searchOpen: false,
  dialog: null as DialogKind,
  journeyOverlay: false,
  focusRequest: null,
};

export const useUiStore = create<UiState>((set, get) => ({
  ...initial,
  setViewMode: (viewMode) => set({ viewMode }),
  openPanel: (panel) => set({ panel }),
  togglePanel: (p) => set((s) => ({ panel: s.panel === p ? null : p })),
  selectNode: (id, openPanel = true) =>
    set((s) => ({
      selectedNodeId: id,
      selectedEdgeId: null,
      panel: id && openPanel ? "node" : s.panel === "node" && !id ? null : s.panel,
    })),
  selectEdge: (id) => set((s) => ({ selectedEdgeId: id, selectedNodeId: null, panel: id ? "edge" : s.panel === "edge" ? null : s.panel })),
  setFocusNode: (focusNodeId) => set({ focusNodeId }),
  setBranch: (branch) => set({ branch }),
  setFilters: (f) => set((s) => ({ filters: { ...s.filters, ...f } })),
  clearFilters: () => set({ filters: DEFAULT_FILTERS }),
  setColorBy: (colorBy) => set({ colorBy }),
  setViewport: (viewport) => set({ viewport }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setDialog: (dialog) => set({ dialog }),
  toggleJourney: () => set((s) => ({ journeyOverlay: !s.journeyOverlay })),
  requestFocus: (id) => set({ focusRequest: { id, at: Date.now() } }),
  restore: (v) =>
    set(
      v
        ? {
            viewMode: (["graph", "focus", "list", "grid", "timeline"] as ViewMode[]).includes(v.view_mode) ? v.view_mode : "graph",
            panel: v.panel,
            selectedNodeId: v.selected_node_id,
            selectedEdgeId: v.selected_edge_id,
            focusNodeId: v.focus_node_id,
            branch: v.branch,
            filters: { ...DEFAULT_FILTERS, ...v.filters },
            colorBy: v.color_by,
            viewport: { x: v.x, y: v.y, zoom: v.zoom },
          }
        : { ...initial },
    ),
  snapshot: () => {
    const s = get();
    return {
      zoom: s.viewport.zoom,
      x: s.viewport.x,
      y: s.viewport.y,
      selected_node_id: s.selectedNodeId,
      selected_edge_id: s.selectedEdgeId,
      view_mode: s.viewMode,
      panel: s.panel,
      branch: s.branch,
      filters: s.filters,
      color_by: s.colorBy,
      focus_node_id: s.focusNodeId,
    };
  },
  reset: () => set({ ...initial }),
}));

export function filtersActive(f: GraphFilters) {
  return (
    f.tag_ids.length + f.category_ids.length + f.domains.length + f.page_types.length + f.collaborator_ids.length > 0 ||
    !f.show_suggested ||
    f.show_weak
  );
}
