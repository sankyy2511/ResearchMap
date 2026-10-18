"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowCounterClockwise, DownloadSimple, Plug, PuzzlePiece, Robot, Wrench } from "@phosphor-icons/react";
import { EXTENSION_ZIP } from "@/features/extension/InstallGuide";
import type { CreatedToken } from "@/types/api";
import { tokensApi } from "@/lib/api";
import { API_MODE, absoluteApiBase } from "@/lib/api/config";
import { connectExtension } from "@/lib/extension/bridge";
import { toast } from "@/lib/toast";
import { timeAgo } from "@/lib/utils/format";
import { AuthGate } from "@/components/shell/AuthGate";
import { AppHeader } from "@/components/shell/AppHeader";
import { Button } from "@/components/ui/button";
import { ArtTile, Avatar, Card, CopyField, Kicker, Pill, Switch } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlay";
import { useAuthStore } from "@/stores/auth";
import { useExtensionStore } from "@/stores/extension";

function DemoControls() {
  const router = useRouter();
  const [ctl, setCtl] = useState<{ latency: number; offline: boolean; aiOutage: boolean } | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    void import("@/mock/core").then((m) => setCtl({ ...m.mockControls }));
  }, []);
  const update = async (patch: Partial<NonNullable<typeof ctl>>) => {
    const m = await import("@/mock/core");
    Object.assign(m.mockControls, patch);
    setCtl({ ...m.mockControls });
  };
  if (!ctl) return null;
  return (
    <Card className="p-6">
      <div className="flex items-center gap-3"><ArtTile icon={Wrench} tone="sun" /><div><h2 className="text-lg font-bold">Demo controls</h2><p className="text-sm text-muted">The backend is simulated in your browser (NEXT_PUBLIC_API_MODE=mock). Use these to demo loading and error states.</p></div></div>
      <div className="mt-5 space-y-4">
        <label className="flex items-center justify-between gap-4"><span><span className="block text-sm font-bold">Simulate API unavailable</span><span className="text-xs text-muted">Every request fails with “Connection lost”.</span></span><Switch label="Simulate API unavailable" checked={ctl.offline} onCheckedChange={(v) => void update({ offline: v })} /></label>
        <label className="flex items-center justify-between gap-4"><span><span className="block text-sm font-bold">Simulate AI outage</span><span className="text-xs text-muted">Pages still appear; connections fall back to embedding-only.</span></span><Switch label="Simulate AI outage" checked={ctl.aiOutage} onCheckedChange={(v) => void update({ aiOutage: v })} /></label>
        <label className="block"><span className="text-sm font-bold">Network latency: {ctl.latency} ms</span><input type="range" min={0} max={2000} step={50} value={ctl.latency} onChange={(e) => void update({ latency: Number(e.target.value) })} className="mt-2 w-full accent-purple" aria-label="Latency" /></label>
        <Button variant="danger" size="sm" onClick={() => setConfirm(true)}><ArrowCounterClockwise size={16} weight="bold" /> Reset demo data</Button>
      </div>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} danger title="Reset demo data?" confirmLabel="Reset" message="All mock data in this browser returns to the seeded demo. You will be signed out." onConfirm={async () => {
        const m = await import("@/mock/core");
        m.resetDb();
        const db = await import("@/mock/db");
        db.sessionCookie.set(null);
        useAuthStore.setState({ user: null, status: "unauthenticated" });
        router.replace("/login");
      }} />
    </Card>
  );
}

function Settings() {
  const user = useAuthStore((s) => s.user)!;
  const qc = useQueryClient();
  const { connected, simulated, setConnected, setSimulated } = useExtensionStore();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: tokensApi.list });
  const [fresh, setFresh] = useState<CreatedToken | null>(null);
  const create = useMutation({ mutationFn: (k: "extension" | "mcp") => tokensApi.create(k, k === "mcp" ? "AI Assistant (MCP)" : "Chrome extension"), onSuccess: (t) => { setFresh(t); void qc.invalidateQueries({ queryKey: ["tokens"] }); toast.success("MCP token created", { description: "Follow the steps below." }); }, onError: (e) => toast.apiError(e) });
  const revoke = useMutation({ mutationFn: tokensApi.revoke, onSuccess: () => { void qc.invalidateQueries({ queryKey: ["tokens"] }); toast.info("Connection removed"); } });
  const mcpTokens = (tokens.data ?? []).filter((t) => t.kind === "mcp");
  const mcpUrl = `${absoluteApiBase()}/mcp`;

  return (
    <div className="min-h-dvh bg-app pb-28 md:pb-12">
      <AppHeader />
      <main className="mx-auto max-w-3xl space-y-5 px-4 pt-8 sm:px-6">
        <div><Kicker tone="lavender">Settings</Kicker><h1 className="mt-3 text-[1.875rem] font-extrabold">Profile & connections</h1></div>
        <Card className="flex items-center gap-4 p-6"><Avatar name={user.name} color={user.avatar_color} size={56} /><div><p className="text-lg font-bold">{user.name}</p><p className="text-sm text-muted">{user.email}</p></div></Card>

        <Card className="p-6">
          <div className="flex items-center gap-3"><ArtTile icon={PuzzlePiece} tone="mint" /><div className="flex-1"><h2 className="text-lg font-bold">Chrome extension</h2><p className="text-sm text-muted">Tracks tabs and time, captures pages and previews, powers Go to tab.</p></div><Pill tone={connected ? "mint" : "ink"}>{connected ? "Connected" : "Not connected"}</Pill></div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={async () => { const ok = await connectExtension({ forceNewToken: true }).catch(() => false); setConnected(ok); if (ok) toast.success("Extension connected"); else toast.warning("Extension not found", { description: "Install it first: open Install steps on this card and follow them." }); }}><Plug size={16} weight="bold" /> Connect extension</Button>
            <Link href="/extension"><Button variant="secondary" size="sm">Install steps</Button></Link>
            <a href={EXTENSION_ZIP} download><Button variant="ghost" size="sm"><DownloadSimple size={16} weight="bold" /> Download ZIP</Button></a>
          </div>
          {API_MODE === "mock" && <label className="mt-4 flex items-center justify-between gap-4 rounded-2xl bg-canvas p-3"><span><span className="block text-sm font-bold">Use browsing simulator (demo)</span><span className="text-xs text-muted">While tracking, a scripted research journey stands in for the extension.</span></span><Switch label="Use browsing simulator" checked={simulated} onCheckedChange={setSimulated} /></label>}
        </Card>

        <Card className="p-6">
          <div className="flex items-center gap-3"><ArtTile icon={Robot} tone="purple" /><div><h2 className="text-lg font-bold">Connect an AI assistant (MCP)</h2><p className="text-sm text-muted">Any AI assistant that supports MCP (Gemini CLI, Cursor, VS Code Cline or Claude) can search your workspaces and add pages and notes to your canvas.</p></div></div>
          <Button variant="purple" size="sm" className="mt-4" loading={create.isPending} onClick={() => create.mutate("mcp")}>Create MCP token</Button>
          {fresh && (
            <div className="mt-4 space-y-4 rounded-2xl border border-line bg-white p-4">
              <div className="space-y-2">
                <p className="text-sm font-bold text-ink">1. For Gemini CLI, run this once in Command Prompt (not inside Gemini):</p>
                <CopyField value={`gemini mcp add -s user -t http -H "Authorization: Bearer ${fresh.token}" --trust research-map ${mcpUrl}`} label="Copy" />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-bold text-ink">2. Type <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-xs">gemini</code> to start it, then ask, for example:</p>
                <CopyField value="Using Research Map, research the best CRM for our 20-person sales team. Set my goal as 'Pick a CRM for our sales team' and add every useful source." label="Copy" />
              </div>
              <details className="text-xs text-muted">
                <summary className="cursor-pointer font-semibold">Using Claude Code or another AI tool?</summary>
                <div className="mt-2 space-y-2">
                  <p>Claude Code: run this in your terminal.</p>
                  <CopyField value={`claude mcp add --transport http research-map ${mcpUrl} --header "Authorization: Bearer ${fresh.token}"`} label="Copy" />
                  <p>Other tools: server address {mcpUrl}, with this key as a Bearer token. It is shown only once.</p>
                  <CopyField value={fresh.token} label="Copy" />
                </div>
              </details>
            </div>
          )}
          {!!mcpTokens.length && (
            <div className="mt-5 border-t border-line pt-3">
              <p className="text-xs font-bold text-muted">Your MCP tokens</p>
              <ul className="mt-1 divide-y divide-line">
                {mcpTokens.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
                    <span className="flex-1 font-semibold">{t.name}</span>
                    <span className="text-xs text-muted">added {timeAgo(t.created_at)}</span>
                    <Button size="xs" variant="ghost" className="text-danger" onClick={() => revoke.mutate(t.id)}>Remove</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
        {API_MODE === "mock" && <DemoControls />}
      </main>
    </div>
  );
}

export default function SettingsPage() {
  return <AuthGate><Settings /></AuthGate>;
}
