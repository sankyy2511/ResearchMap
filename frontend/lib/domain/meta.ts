import type { AiStage, ConflictLabel, NodeType, PageType, Relation, TabState } from "@/types/api";

/** The 7-tone palette from DESIGN.md §3.2. */
export type Tone = "purple" | "lavender" | "sun" | "coral" | "mint" | "sky" | "pink" | "cream" | "ink";

export const TONE_HEX: Record<Tone, { solid: string; soft: string; deep: string }> = {
  purple: { solid: "#ee7048", soft: "#fdebe3", deep: "#c4492a" },
  lavender: { solid: "#f8c9b4", soft: "#fdebe3", deep: "#c4492a" },
  sun: { solid: "#f5d4a6", soft: "#fcf0df", deep: "#96601f" },
  coral: { solid: "#f3a283", soft: "#fde3d9", deep: "#c4502f" },
  mint: { solid: "#c9e0d0", soft: "#e8f4dc", deep: "#3a7552" },
  sky: { solid: "#c5d1e0", soft: "#e3effc", deep: "#3d5f88" },
  pink: { solid: "#f4cdc6", soft: "#fde4e2", deep: "#c9544f" },
  cream: { solid: "#fdeedc", soft: "#fdeedc", deep: "#96601f" },
  ink: { solid: "#12151c", soft: "#eceff3", deep: "#12151c" },
};

/** Static class maps so Tailwind can see every class. */
export const TONE_BG: Record<Tone, string> = {
  purple: "bg-purple text-white",
  lavender: "bg-lavender",
  sun: "bg-sun",
  coral: "bg-coral",
  mint: "bg-mint",
  sky: "bg-sky",
  pink: "bg-pink",
  cream: "bg-cream",
  ink: "bg-ink text-white",
};
export const TONE_SOFT: Record<Tone, string> = {
  purple: "bg-lavender-soft text-purple-deep",
  lavender: "bg-lavender-soft text-purple-deep",
  sun: "bg-sun-soft text-sun-deep",
  coral: "bg-coral-soft text-coral-deep",
  mint: "bg-mint-soft text-mint-deep",
  sky: "bg-sky-soft text-sky-deep",
  pink: "bg-pink-soft text-pink-deep",
  cream: "bg-cream text-sun-deep",
  ink: "bg-canvas-cool text-ink",
};

/** Palette offered when the user picks a tag / category colour. */
export const PICKER_COLORS = ["#ee7048", "#f3a283", "#f5d4a6", "#c9e0d0", "#c5d1e0", "#f4cdc6", "#f8c9b4", "#12151c"];

export function toneForHex(hex: string): Tone {
  const h = hex.toLowerCase();
  const found = (Object.keys(TONE_HEX) as Tone[]).find(
    (t) => TONE_HEX[t].solid === h || TONE_HEX[t].deep === h || TONE_HEX[t].soft === h,
  );
  return found ?? "lavender";
}

/** Pick readable text colour for a solid background. */
export function textOn(hex: string): string {
  const c = hex.replace("#", "");
  if (c.length !== 6) return "#12151c";
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? "#12151c" : "#ffffff";
}

/* ---------------------------------------------------------------- relations (§14.3) */

export interface RelationMeta {
  label: string;
  verb: string;
  tone: Tone;
  stroke: string;
  description: string;
  deterministic?: boolean;
}

export const RELATIONS: Record<Relation, RelationMeta> = {
  answers: { label: "Answers", verb: "answers", tone: "mint", stroke: "#3a7552", description: "Page answers a question node" },
  subtopic_of: { label: "Part of", verb: "is part of", tone: "sky", stroke: "#3d5f88", description: "Page is a more detailed part of a topic" },
  explains: { label: "Explains", verb: "explains", tone: "purple", stroke: "#c4492a", description: "Page explains a concept used in another page" },
  supports: { label: "Agrees", verb: "agrees with", tone: "mint", stroke: "#23864b", description: "Page gives evidence for another page's claim" },
  contradicts: { label: "Disagrees", verb: "disagrees with", tone: "coral", stroke: "#c93535", description: "Pages disagree (creates a Conflict Radar item)" },
  example_of: { label: "Example", verb: "is an example of", tone: "sun", stroke: "#96601f", description: "Page is an example or case study of another" },
  prerequisite_of: { label: "Read first", verb: "should be read before", tone: "lavender", stroke: "#ee7048", description: "Read this first to understand the other" },
  alternative_to: { label: "Alternative", verb: "is an alternative to", tone: "pink", stroke: "#c9544f", description: "Two options for the same job" },
  same_topic: { label: "Same topic", verb: "is on the same topic as", tone: "ink", stroke: "#625f78", description: "Related, same subject, no stronger type fits" },
  source_of: { label: "Source", verb: "is the source of", tone: "cream", stroke: "#96601f", description: "Original source another page is based on" },
  opened_from: { label: "Opened from", verb: "was opened from", tone: "ink", stroke: "#9a9ea7", description: "Navigation trail (no AI)", deterministic: true },
  links_to: { label: "Links to", verb: "links to", tone: "ink", stroke: "#9a9ea7", description: "Hyperlink between pages (no AI)", deterministic: true },
  duplicate_of: { label: "Same page", verb: "is the same page as", tone: "pink", stroke: "#c9544f", description: "Same content (possible duplicate)" },
};

export const USER_SELECTABLE_RELATIONS: Relation[] = [
  "answers",
  "subtopic_of",
  "explains",
  "supports",
  "contradicts",
  "example_of",
  "prerequisite_of",
  "alternative_to",
  "same_topic",
  "source_of",
  "duplicate_of",
];

export const ORIGIN_LABEL = {
  ai: "AI suggestion (Agent 2)",
  user: "Added by you",
  navigation: "Navigation trail",
  link: "Hyperlink",
  embedding: "Similar content (embedding only)",
  mcp: "Suggested by an AI assistant (MCP)",
} as const;

/* ---------------------------------------------------------------- page types */

export const PAGE_TYPE_LABEL: Record<PageType, string> = {
  article: "Article",
  documentation: "Documentation",
  research_paper: "Research paper",
  video: "Video",
  forum_discussion: "Forum",
  news: "News",
  product_page: "Product",
  tutorial: "Tutorial",
  reference: "Reference",
  dataset: "Dataset",
  other: "Other",
};

export const PAGE_TYPE_TONE: Record<PageType, Tone> = {
  article: "sky",
  documentation: "lavender",
  research_paper: "purple",
  video: "coral",
  forum_discussion: "pink",
  news: "sun",
  product_page: "cream",
  tutorial: "mint",
  reference: "sky",
  dataset: "mint",
  other: "ink",
};

export const NODE_TYPE_LABEL: Record<NodeType, string> = {
  page: "Page",
  question: "Question",
  note: "Note",
  finding: "Finding",
  topic: "Topic",
};

/* ---------------------------------------------------------------- AI stages (§14.1) */

export const AI_STAGES: { stage: AiStage; label: string; message: string }[] = [
  { stage: "captured", label: "Captured", message: "Page captured" },
  { stage: "analyzing", label: "Analyzing", message: "Agent 1 · Analyzing page…" },
  { stage: "understood", label: "Understood", message: "Agent 1 · Understanding content…" },
  { stage: "organizing", label: "Organizing", message: "Agent 2 · Finding relationships…" },
  { stage: "connected", label: "Connected", message: "Agent 3 · Updating Research Memory…" },
  { stage: "ready", label: "Ready", message: "Ready" },
  { stage: "failed", label: "Failed", message: "AI analysis unavailable" },
];

export function stageIndex(stage: AiStage): number {
  return AI_STAGES.findIndex((s) => s.stage === stage);
}
export function isProcessing(stage: AiStage): boolean {
  return stage !== "ready" && stage !== "failed";
}

export const TAB_STATE_META: Record<TabState, { label: string; dot: string }> = {
  active: { label: "Active tab", dot: "bg-success" },
  open: { label: "Open in a tab", dot: "bg-info" },
  closed: { label: "Closed", dot: "bg-faint" },
  live: { label: "LIVE", dot: "bg-danger" },
};

export const CONFLICT_LABEL: Record<ConflictLabel, string> = {
  contradict: "Potential conflict",
  partially_contradict: "Partial disagreement",
  different_context: "Different context",
};

export const IMPORTANCE_LABEL: Record<1 | 2 | 3, { label: string; color: string }> = {
  3: { label: "High", color: "#c93535" },
  2: { label: "Medium", color: "#a4660a" },
  1: { label: "Low", color: "#9a9ea7" },
};

/** Stable colour from a string (domains, topics without a category). */
const HASH_PALETTE = ["#ee7048", "#f3a283", "#e0a93a", "#3a7552", "#3d5f88", "#e0716c", "#c9a27e", "#3a7552"];
export function colorFromString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return HASH_PALETTE[h % HASH_PALETTE.length]!;
}
