"use client";
/** Derived visuals for a node: colour-by accent, badges, presence. Kept out of render components. */
import { useStore as useFlowStore } from "@xyflow/react";
import type { ResearchNode } from "@/types/api";
import { colorFromString, IMPORTANCE_LABEL, PAGE_TYPE_TONE, TONE_HEX } from "@/lib/domain/meta";
import { useGraphStore } from "@/stores/graph";
import { useUiStore } from "@/stores/ui";
import { useCollabStore, useSignalsStore } from "@/stores/collab";
import { useAuthStore } from "@/stores/auth";

export function useZoomedOut() {
  return useFlowStore((s) => s.transform[2] < 0.5);
}

export function useAccent(node: ResearchNode): string {
  const colorBy = useUiStore((s) => s.colorBy);
  return useGraphStore((s) => {
    switch (colorBy) {
      case "topic": {
        if (node.type === "topic") return node.body || "#ee7048";
        const parent = node.parent_id ? s.nodes.find((n) => n.id === node.parent_id)?.data.node : null;
        return parent?.body || "#9a9ea7";
      }
      case "source": {
        const p = node.page_id ? s.pages[node.page_id] : null;
        const cat = node.category_id ? s.categories.find((c) => c.id === node.category_id) : null;
        return cat?.kind === "source" ? cat.color : p ? colorFromString(p.domain) : "#9a9ea7";
      }
      case "importance":
        return node.importance ? IMPORTANCE_LABEL[node.importance].color : "#e3e7ef";
      case "page_type": {
        const p = node.page_id ? s.pages[node.page_id] : null;
        return p?.page_type ? TONE_HEX[PAGE_TYPE_TONE[p.page_type]].deep : "#9a9ea7";
      }
      case "collaborator":
        return node.created_via === "mcp" ? "#ee7048" : node.created_by ? colorFromString(node.created_by) : "#9a9ea7";
      case "branch":
        return s.branches.find((b) => b.id === node.branch_id)?.color ?? "#12151c";
    }
  });
}

export function useNodeSignals(node: ResearchNode) {
  const conflict = useSignalsStore((s) =>
    s.conflicts.some((c) => c.status === "open" && (c.node_a_id === node.id || c.node_b_id === node.id)),
  );
  const myId = useAuthStore((s) => s.user?.id);
  const viewer = useCollabStore((s) => s.presence.find((p) => p.id !== myId && p.selected_node_id === node.id));
  const flash = useGraphStore((s) => s.flashId === node.id);
  const otherBranch = useGraphStore((s) => {
    const b = s.branches.find((x) => x.id === node.branch_id);
    return b && b.kind !== "main" ? b : null;
  });
  return { conflict, viewer, flash, otherBranch };
}
