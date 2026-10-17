import type { NodeType } from "@/types/api";

/** Default rendered sizes per node type (used for placement + overlap checks). */
export const NODE_SIZE: Record<Exclude<NodeType, "topic">, { w: number; h: number }> = {
  page: { w: 300, h: 330 },
  question: { w: 248, h: 118 },
  note: { w: 236, h: 150 },
  finding: { w: 252, h: 146 },
};

export const TOPIC_PADDING = { top: 64, side: 24, bottom: 24 };
export const TOPIC_COLLAPSED = { w: 280, h: 72 };
const GAP = 24;

export function sizeOf(type: NodeType) {
  return type === "topic" ? { w: 600, h: 400 } : NODE_SIZE[type];
}

/**
 * Pack child nodes into a grid inside a topic group.
 * Returns child positions (relative to the group) and the group size.
 */
export function packTopic(children: { id: string; type: NodeType }[]) {
  const n = children.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  const cellW = NODE_SIZE.page.w + GAP;
  const rowHeights: number[] = [];
  children.forEach((c, i) => {
    const row = Math.floor(i / cols);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, sizeOf(c.type).h);
  });
  const positions: Record<string, { x: number; y: number }> = {};
  children.forEach((c, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const y = TOPIC_PADDING.top + rowHeights.slice(0, row).reduce((a, b) => a + b + GAP, 0);
    positions[c.id] = { x: TOPIC_PADDING.side + col * cellW, y };
  });
  const width = Math.max(TOPIC_COLLAPSED.w, TOPIC_PADDING.side * 2 + Math.min(n, cols) * cellW - GAP);
  const height = TOPIC_PADDING.top + rowHeights.reduce((a, b) => a + b + GAP, 0) - GAP + TOPIC_PADDING.bottom;
  return { positions, width, height: Math.max(height, 160) };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: Box, b: Box, margin = 16) {
  return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
}

/**
 * Place a new node to the right of an anchor, avoiding overlap (§14.5 placement rule).
 * Works in absolute coordinates.
 */
export function placeNear(anchor: Box | null, size: { w: number; h: number }, occupied: Box[]): { x: number; y: number } {
  const start = anchor ? { x: anchor.x + anchor.w + 60, y: anchor.y } : { x: 0, y: 0 };
  for (let ring = 0; ring < 40; ring++) {
    const candidates = [
      { x: start.x, y: start.y + ring * (size.h + 20) },
      { x: start.x, y: start.y - ring * (size.h + 20) },
      { x: start.x + ring * (size.w + 20), y: start.y },
    ];
    for (const c of candidates) {
      const box = { ...c, w: size.w, h: size.h };
      if (!occupied.some((o) => overlaps(box, o))) return c;
    }
  }
  return { x: start.x, y: start.y + occupied.length * 30 };
}

/** Place top-level blocks (topic groups) in a masonry of `cols` columns. */
export function masonry(blocks: { id: string; w: number; h: number }[], cols = 3, gap = 80) {
  const colY = new Array(cols).fill(0) as number[];
  const colX: number[] = [];
  const colW = new Array(cols).fill(0) as number[];
  blocks.forEach((b, i) => {
    const c = i % cols;
    colW[c] = Math.max(colW[c]!, b.w);
  });
  let acc = 0;
  for (let c = 0; c < cols; c++) {
    colX[c] = acc;
    acc += colW[c]! + gap;
  }
  const out: Record<string, { x: number; y: number }> = {};
  blocks.forEach((b) => {
    const c = colY.indexOf(Math.min(...colY));
    out[b.id] = { x: colX[c]!, y: colY[c]! };
    colY[c]! += b.h + gap;
  });
  return out;
}
