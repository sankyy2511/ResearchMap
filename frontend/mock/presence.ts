/**
 * Simulated collaborators for the demo (F21): Maya is online, moves her selection around
 * and occasionally leaves a comment. Emits `presence` and `annotation.created` like the Go hub.
 */
import type { PresenceUser } from "@/types/api";
import { mockBus } from "./bus";
import { currentUser, getDb, persist, publish } from "./core";
import { uid } from "./db";

const COMMENTS = [
  "Can we find a second source for this?",
  "Adding this to my branch too.",
  "This one is useful for the report intro.",
];

const running = new Map<string, () => void>();

export function startPresence(workspaceId: string) {
  if (running.has(workspaceId)) return;
  const selections = new Map<string, string | null>();
  let tick = 0;

  const emit = () => {
    const d = getDb();
    const me = currentUser();
    const members = d.members.filter((m) => m.workspace_id === workspaceId);
    const users: PresenceUser[] = [];
    if (me) users.push({ id: me.id, name: me.name, color: me.avatar_color, selected_node_id: selections.get(me.id) ?? null });
    const maya = d.users.find((u) => u.email.startsWith("maya") && members.some((m) => m.user_id === u.id));
    if (maya && tick % 9 !== 8) {
      const nodes = d.nodes.filter((n) => n.workspace_id === workspaceId && !n.deleted_at && n.type === "page");
      const sel = nodes.length ? nodes[(tick * 7) % nodes.length]!.id : null;
      users.push({ id: maya.id, name: maya.name, color: maya.avatar_color, selected_node_id: sel });
      if (tick > 0 && tick % 6 === 0 && sel) {
        const a = {
          id: uid(), workspace_id: workspaceId, node_id: sel, kind: "comment" as const, body: COMMENTS[(tick / 6) % COMMENTS.length]!,
          quote: null, fragment_url: null, parent_id: null, resolved: false, author_id: maya.id, author_name: maya.name,
          author_color: maya.avatar_color, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        d.annotations.push(a);
        persist();
        publish({ type: "annotation.created", workspace_id: workspaceId, by: maya.id, data: a });
      }
    }
    publish({ type: "presence", workspace_id: workspaceId, by: null, data: { users } });
    tick++;
  };

  const offClient = mockBus.onClientMessage((ws, msg) => {
    if (ws !== workspaceId) return;
    const me = currentUser();
    if (msg.type === "presence.update" && me) {
      selections.set(me.id, msg.data.selected_node_id);
      emit();
    }
  });
  const iv = setInterval(emit, 10000);
  setTimeout(emit, 600);
  running.set(workspaceId, () => {
    clearInterval(iv);
    offClient();
  });
}

export function stopPresence(workspaceId: string) {
  running.get(workspaceId)?.();
  running.delete(workspaceId);
}
