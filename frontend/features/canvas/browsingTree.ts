/**
 * Canvas layout: pages grouped into clusters of similar pages, in the order they were opened.
 * A cluster is the topic Gemini gave the page; a page without a topic joins the search it was opened from,
 * and any other page goes to "Other pages". Inside a cluster pages run left to right, then the next row,
 * and each page shows its number (1, 2, 3 …) in the order it was opened.
 * Positions are computed here every time, so the canvas is always tidy and nothing needs saving.
 */
import { sizeOf } from "@/lib/graph/layout";
import type { NodeType } from "@/types/api";
import type { RFEdge, RFNode } from "@/stores/graph";

const GAP_X = 40; // between pages in a row
const GAP_Y = 48; // between rows
const PER_ROW = 4; // pages per row inside a cluster
const PAD = { top: 64, side: 32, bottom: 32 }; // inside a cluster box
const CLUSTER_GAP = 80; // between clusters
const MIN_BOX_WIDTH = 420; // room for the cluster name even with one page
const MAX_ROW_WIDTH = 3200; // clusters wrap on the canvas
const CLUSTER_COLORS = ["#ee7048", "#2f6a8f", "#96601f", "#3f8a2e", "#7b5cf0", "#c9544f"];

function pageSize(n: RFNode) {
  const d = n.data.node;
  const base = sizeOf(d.type as NodeType);
  return { w: d.width ?? base.w, h: d.height ?? base.h };
}

interface Cluster {
  key: string;
  label: string;
  color: string;
  pages: RFNode[];
}

/** Which cluster a page belongs to: Gemini's topic, else the search it came from, else "Other pages". */
function clusterOf(page: RFNode, topics: Map<string, RFNode>): { key: string; label: string; color?: string } {
  const topic = page.parentId ? topics.get(page.parentId) : undefined;
  if (topic) return { key: topic.id, label: topic.data.node.title, color: topic.data.node.body || undefined };
  const q = page.data.node.why_opened?.search_query?.trim();
  if (q) return { key: "search:" + q.toLowerCase(), label: `Search: ${q}` };
  return { key: "other", label: "Other pages" };
}

export function buildBrowsingTree(allNodes: RFNode[], noteFor: (n: RFNode) => string | undefined): { nodes: RFNode[]; edges: RFEdge[] } {
  const topics = new Map(allNodes.filter((n) => n.type === "topic").map((n) => [n.id, n]));
  const pages = allNodes.filter((n) => n.type !== "topic").sort((a, b) => a.data.node.created_at.localeCompare(b.data.node.created_at));

  // Clusters in the order their first page was opened.
  const clusters = new Map<string, Cluster>();
  for (const page of pages) {
    const c = clusterOf(page, topics);
    if (!clusters.has(c.key)) clusters.set(c.key, { key: c.key, label: c.label, color: c.color ?? CLUSTER_COLORS[clusters.size % CLUSTER_COLORS.length]!, pages: [] });
    clusters.get(c.key)!.pages.push(page);
  }

  // 1, 2, 3 … in the order the pages were opened, across the whole canvas.
  const orderOf = new Map(pages.map((p, i) => [p.id, i + 1]));
  const boxes: RFNode[] = [];
  const placed: RFNode[] = [];
  let cx = 0;
  let cy = 0;
  let rowHeight = 0;
  for (const cluster of clusters.values()) {
    // Pages in the order they were opened: left to right, then the next row.
    const inner: { page: RFNode; x: number; y: number }[] = [];
    let x = 0;
    let y = 0;
    let lineHeight = 0;
    let width = 0;
    cluster.pages.forEach((page, i) => {
      const { w, h } = pageSize(page);
      if (i > 0 && i % PER_ROW === 0) {
        x = 0;
        y += lineHeight + GAP_Y;
        lineHeight = 0;
      }
      inner.push({ page, x, y });
      x += w + GAP_X;
      width = Math.max(width, x - GAP_X);
      lineHeight = Math.max(lineHeight, h);
    });
    const boxW = Math.max(width + PAD.side * 2, MIN_BOX_WIDTH);
    const boxH = y + lineHeight + PAD.top + PAD.bottom;
    if (cx > 0 && cx + boxW > MAX_ROW_WIDTH) {
      cx = 0;
      cy += rowHeight + CLUSTER_GAP;
      rowHeight = 0;
    }
    boxes.push({
      id: `cluster-${cluster.key}`,
      type: "cluster",
      position: { x: cx, y: cy },
      data: { label: cluster.label, color: cluster.color, count: cluster.pages.length } as unknown as RFNode["data"],
      width: boxW,
      height: boxH,
      style: { width: boxW, height: boxH },
      selectable: false,
      draggable: false,
      focusable: false,
      zIndex: -1,
    } as RFNode);
    for (const { page, x: px, y: py } of inner) {
      placed.push({
        ...page,
        data: { ...page.data, note: noteFor(page), order: orderOf.get(page.id) },
        parentId: undefined,
        extent: undefined,
        hidden: false,
        draggable: false,
        position: { x: cx + PAD.side + px, y: cy + PAD.top + py },
      });
    }
    cx += boxW + CLUSTER_GAP;
    rowHeight = Math.max(rowHeight, boxH);
  }
  return { nodes: [...boxes, ...placed], edges: [] };
}
