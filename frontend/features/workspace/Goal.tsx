"use client";
/**
 * Session goal: the user writes what they want to finish in this session. The extension checks every page
 * against it and warns about pages that are not part of it. The goal button shows how close the user is.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle, Crosshair, PencilSimple, Warning } from "@phosphor-icons/react";
import type { Session } from "@/types/api";
import { sessionApi } from "@/lib/api";
import { formatDuration } from "@/lib/utils/format";
import { normalizeUrl } from "@/lib/utils/url";
import { useGraphStore } from "@/stores/graph";
import { Modal, Pop } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Label, Switch, Textarea } from "@/components/ui/primitives";
import { toast } from "@/lib/toast";
import { qk } from "@/features/workspaces/hooks";

const MAX_GOAL = 500;

/** Clickable examples: they show what a good goal looks like and fill the box in one click. */
const GOAL_EXAMPLES = [
  "Prepare for my exam tomorrow on operating systems",
  "Learn the basics of deep learning",
  "Understand Docker and Kubernetes for DevOps",
  "Compare the best tools for a project decision",
];

function GoalExamples({ onPick }: { onPick: (goal: string) => void }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-bold text-muted">Or choose an example and change it:</p>
      <div className="flex flex-wrap gap-1.5">
        {GOAL_EXAMPLES.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => onPick(g)}
            className="rounded-full border border-line bg-white px-3 py-1.5 text-left text-xs font-semibold text-ink-soft transition hover:border-purple hover:text-purple-deep"
          >
            {g}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Asks for the session goal. Three uses:
 * "ask": the question shown once, right after a workspace is created. A switch decides if there is a goal; nothing starts yet.
 * "start": the Start Tracking button was clicked and no answer was given before.
 * "edit": the user changes the goal of the running session.
 */
export function GoalDialog({
  open,
  onOpenChange,
  workspaceId,
  initial,
  mode,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  /** The current goal when editing. */
  initial?: string;
  mode: "ask" | "start" | "edit";
  onSubmit: (goal: string) => Promise<unknown>;
}) {
  const [typed, setTyped] = useState<string | null>(null); // null until the user types: then the suggestion is shown
  const [hasGoal, setHasGoal] = useState(false); // the switch of the "ask" question
  const [busy, setBusy] = useState<"goal" | "skip" | null>(null);
  // Starting a new session: suggest the goal of the last session in this workspace (most people continue it).
  const sessions = useQuery({ queryKey: qk.sessions(workspaceId), queryFn: () => sessionApi.list(workspaceId), enabled: open && mode === "start" });
  const suggested = mode === "edit" ? (initial ?? "") : mode === "start" ? (sessions.data?.find((s) => s.goal)?.goal ?? "") : "";
  const goal = typed ?? suggested;
  const showGoalBox = mode !== "ask" || hasGoal;
  const setOpen = (o: boolean) => {
    if (!o) {
      setTyped(null);
      setHasGoal(false);
    }
    onOpenChange(o);
  };

  const submit = async (value: string, which: "goal" | "skip") => {
    setBusy(which);
    try {
      await onSubmit(value.trim());
      setOpen(false);
    } finally {
      setBusy(null);
    }
  };
  const needsGoal = showGoalBox && !goal.trim();

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      size="sm"
      title={mode === "ask" ? "Do you have a goal for today?" : mode === "start" ? "What is your goal for this session?" : "Change your goal"}
      description={
        mode === "ask"
          ? "A goal helps you stay on your work. We will tell you when a page is not part of it."
          : "Write what you want to learn or finish. We will tell you when a page is not part of your goal."
      }
      footer={
        <>
          {mode === "start" ? (
            <Button variant="ghost" loading={busy === "skip"} disabled={!!busy} onClick={() => void submit("", "skip")}>
              Start without a goal
            </Button>
          ) : (
            <Button variant="ghost" disabled={!!busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          )}
          <Button variant="purple" type="submit" form="goal-form" loading={busy === "goal"} disabled={needsGoal || !!busy}>
            {mode === "ask" ? "Continue" : mode === "start" ? "Start tracking" : "Save goal"}
          </Button>
        </>
      }
    >
      <form
        id="goal-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!needsGoal) void submit(showGoalBox ? goal : "", "goal");
        }}
        className="space-y-3"
      >
        {mode === "ask" && (
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-white p-3">
            <p className="text-sm font-bold text-ink">Yes, I have a goal</p>
            <Switch checked={hasGoal} onCheckedChange={setHasGoal} label="Yes, I have a goal" />
          </div>
        )}
        {showGoalBox && (
          <div className="space-y-2">
            <Label htmlFor="session-goal">Your goal</Label>
            <Textarea
              id="session-goal"
              autoFocus
              maxLength={MAX_GOAL}
              value={goal}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Example: Learn the basics of Docker and Kubernetes for my DevOps exam tomorrow"
              className="min-h-24"
            />
            <p className="text-xs text-muted">Related pages are fine too. For example, Docker pages are fine for a Kubernetes goal.</p>
            {mode === "edit" && <p className="text-xs text-muted">Pages are checked again against the new goal.</p>}
            {!goal.trim() && <GoalExamples onPick={(g) => setTyped(g)} />}
          </div>
        )}
      </form>
    </Modal>
  );
}

const warned = new Set<string>();

/** Tells the user once per goal when the AI is not sure what the goal means. */
function warnIfUnclear(s: Session, onEdit: () => void) {
  const key = `${s.id}:${s.goal}`;
  if (!s.goal_unclear || warned.has(key)) return;
  warned.add(key);
  toast.warning("Please check your goal", {
    description: `We are not sure what “${s.goal}” means. We guessed: ${s.goal_meaning}. Write your goal in full if this is wrong.`,
    action: { label: "Change goal", onClick: onEdit },
    duration: 15000,
  });
}

/** Top-bar button: the goal at a glance; opens the details. */
export function GoalButton({ session, onEdit }: { session: Session; onEdit: () => void }) {
  useEffect(() => warnIfUnclear(session, onEdit), [session, onEdit]);
  if (!session.goal) {
    return (
      <Button size="sm" variant="secondary" onClick={onEdit} className="shrink-0" aria-label="Set a goal">
        <Crosshair size={15} weight="bold" /> <span className="hidden md:inline">Set a goal</span>
      </Button>
    );
  }
  return (
    <Pop
      align="start"
      className="w-[min(22rem,calc(100vw-2rem))] p-0"
      trigger={
        <button
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-white px-3 text-[13px] font-bold shadow-clay-sm transition hover:-translate-y-0.5"
          aria-label="Your goal. Show details"
        >
          {session.goal_unclear ? <Warning size={15} weight="fill" className="text-warning" /> : <Crosshair size={15} weight="bold" className="text-purple" />}
          <span className="hidden md:inline">Goal</span>
          {session.goal_pages_off > 0 && <span className="h-2 w-2 rounded-full bg-warning" aria-hidden />}
        </button>
      }
    >
      <GoalDetails session={session} onEdit={onEdit} />
    </Pop>
  );
}

function GoalDetails({ session: s, onEdit }: { session: Session; onEdit: () => void }) {
  const checks = useQuery({ queryKey: ["goal-checks", s.id], queryFn: () => sessionApi.goalChecks(s.id) });
  const pages = useGraphStore((st) => st.pages);
  // Same pages as the counts: only pages on the canvas, shown with their canvas title.
  const onCanvas = new Map(Object.values(pages).map((p) => [normalizeUrl(p.url), p.title]));
  const offPages = (checks.data ?? [])
    .filter((c) => !c.on_goal && onCanvas.has(normalizeUrl(c.url)))
    .map((c) => ({ ...c, title: onCanvas.get(normalizeUrl(c.url)) || c.title }))
    .slice(0, 5);
  const checked = s.goal_pages_on + s.goal_pages_off;

  return (
    <div className="max-h-[70dvh] overflow-y-auto">
      <div className="border-b border-line p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-bold text-muted">Your goal</p>
          <Button size="xs" variant="ghost" onClick={onEdit}>
            <PencilSimple size={13} weight="bold" /> Change
          </Button>
        </div>
        <p className="mt-1 text-sm font-semibold text-ink">{s.goal}</p>
        {s.goal_unclear ? (
          <p className="mt-2 rounded-xl bg-warning-soft p-2.5 text-xs text-warning">
            Your goal can mean more than one thing. We guessed: <strong>{s.goal_meaning}</strong>. If this is wrong, please change your goal and write it in full.
          </p>
        ) : (
          s.goal_meaning && s.goal_meaning.toLowerCase() !== s.goal.toLowerCase() && (
            <p className="mt-1 text-xs text-muted">We understood this as: {s.goal_meaning}</p>
          )
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 border-b border-line p-4 text-sm">
        <div className="rounded-2xl bg-success-soft p-3">
          <p className="text-xs font-bold text-success">On your goal</p>
          <p className="mt-0.5 font-bold">{formatDuration(s.goal_on_ms)}</p>
          <p className="text-xs text-muted">{s.goal_pages_on} {s.goal_pages_on === 1 ? "page" : "pages"}</p>
        </div>
        <div className="rounded-2xl bg-warning-soft p-3">
          <p className="text-xs font-bold text-warning">On other pages</p>
          <p className="mt-0.5 font-bold">{formatDuration(s.goal_off_ms)}</p>
          <p className="text-xs text-muted">{s.goal_pages_off} {s.goal_pages_off === 1 ? "page" : "pages"}</p>
        </div>
      </div>

      <div className="p-4">
        {checked === 0 ? (
          <p className="text-sm text-muted">Open web pages for your research. We check each page against your goal.</p>
        ) : offPages.length ? (
          <>
            <p className="mb-2 text-sm font-bold">Pages that are not part of your goal</p>
            <ul className="space-y-2">
              {offPages.map((c) => (
                <li key={c.url} className="flex gap-2 text-sm">
                  <Warning size={16} weight="fill" className="mt-0.5 shrink-0 text-warning" />
                  <div className="min-w-0">
                    <a href={c.url} target="_blank" rel="noopener noreferrer" className="block truncate font-semibold hover:underline">
                      {c.title || c.domain}
                    </a>
                    {c.reason && <p className="text-xs text-muted">{c.reason}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-success">
            <CheckCircle size={16} weight="fill" /> All pages you opened are part of your goal.
          </p>
        )}
      </div>
    </div>
  );
}
