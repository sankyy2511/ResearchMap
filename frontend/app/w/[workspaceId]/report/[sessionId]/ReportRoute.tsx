"use client";
/** Session report: key numbers, where the time went, a written summary with key points, and the sources. One page, also used for the PDF. */
import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePathIds } from "@/lib/utils/pathIds";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowLeft, FilePdf, Sparkle } from "@phosphor-icons/react";
import type { ReferenceFormat } from "@/types/api";
import { reportApi, sessionApi, workspaceApi } from "@/lib/api";
import { formatDateTime, formatDuration, formatTime } from "@/lib/utils/format";
import { downloadText, slugify } from "@/lib/utils/download";
import { toast } from "@/lib/toast";
import { APP_NAME } from "@/lib/api/config";
import { AuthGate } from "@/components/shell/AuthGate";
import { UserMenu } from "@/components/shell/AppHeader";
import { Button } from "@/components/ui/button";
import { Card, Kicker, Select } from "@/components/ui/primitives";
import { EmptyState, ErrorState, LoadingBlock, Skeleton } from "@/components/ui/states";
import { qk } from "@/features/workspaces/hooks";

const tooltipStyle = { borderRadius: 14, border: "1px solid #e3e7ef", boxShadow: "0 8px 24px -12px rgba(28,27,43,.25)", fontSize: 12 };

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="font-display text-lg font-bold text-ink">{children}</h3>;
}

function Report({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ["ws", workspaceId], queryFn: () => workspaceApi.get(workspaceId) });
  // While the session is still running, re-check every few seconds so the page shows the end and the final numbers by itself.
  const isLive = (list?: { id: string; state: string }[]) => list?.find((x) => x.id === sessionId)?.state !== "stopped";
  const sessions = useQuery({ queryKey: qk.sessions(workspaceId), queryFn: () => sessionApi.list(workspaceId), refetchInterval: (q) => (isLive(q.state.data) ? 5000 : false) });
  const live = isLive(sessions.data);
  const stats = useQuery({ queryKey: qk.stats(sessionId), queryFn: () => sessionApi.stats(sessionId), refetchInterval: live ? 10000 : false });
  const refs = useQuery({ queryKey: qk.refs(sessionId), queryFn: () => sessionApi.references(sessionId), refetchInterval: live ? 10000 : false });
  const report = useQuery({
    queryKey: qk.report(sessionId),
    queryFn: () => reportApi.get(sessionId),
    retry: false,
    refetchInterval: (q) => (q.state.data?.status === "generating" ? 1000 : false),
  });
  const gen = useMutation({
    mutationFn: () => reportApi.generate(sessionId),
    onSuccess: (r) => { qc.setQueryData(qk.report(sessionId), r); toast.ai("Writing the summary…", { description: "It uses the pages you read in this session." }); },
    onError: (e) => toast.apiError(e),
  });
  // "Stop & generate report" opens this page with ?generate=1: write the summary once if there is none yet.
  const autoGen = useRef(false);
  useEffect(() => {
    if (autoGen.current || !report.isFetched || report.data || new URLSearchParams(window.location.search).get("generate") !== "1") return;
    autoGen.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    gen.mutate();
  }, [report.isFetched, report.data, gen]);
  const session = sessions.data?.find((s) => s.id === sessionId);
  const jump = (nodeId: string | null) => nodeId && router.push(`/w/${workspaceId}?node=${nodeId}`);
  const refNode = (n: number) => refs.data?.references.find((r) => r.ref_number === n)?.node_id ?? null;

  const exportRefs = async (format: ReferenceFormat) => {
    try {
      const r = await sessionApi.references(sessionId, format);
      const content = format === "json" ? JSON.stringify(r.references, null, 2) : r.text ?? "";
      downloadText(`${slugify(session?.title ?? "sources")}-sources.${format === "bibtex" ? "bib" : format}`, content, format === "json" ? "application/json" : "text/plain");
    } catch (e) {
      toast.apiError(e);
    }
  };

  /** Turns [3] in a text into a button that opens that source on the canvas. */
  const withCitations = (text: string) =>
    text.split(/(\[\d+\])/g).map((part, i) => {
      const m = part.match(/^\[(\d+)\]$/);
      if (!m) return <span key={i}>{part}</span>;
      const n = Number(m[1]);
      return <button key={i} onClick={() => jump(refNode(n))} className="mx-0.5 rounded-md bg-lavender-soft px-1 text-xs font-bold text-purple-deep hover:bg-lavender" title="Open this source">[{n}]</button>;
    });

  if (stats.error) return <div className="mx-auto max-w-md p-10"><ErrorState error={stats.error} onRetry={() => void stats.refetch()} /></div>;
  const s = stats.data;
  const content = report.data?.content;
  const goalMs = session ? session.goal_on_ms + session.goal_off_ms : 0;
  const numbers = s && [
    ["Session length", formatDuration(s.total_duration_ms)],
    ["Time reading pages", formatDuration(s.active_ms)],
    ["Pages visited", `${s.pages_visited}`],
    ["Sources saved", `${s.sources_count}`],
    ...(session?.goal && goalMs > 0 ? [["Time on your goal", `${Math.round((session.goal_on_ms / goalMs) * 100)}%`]] : []),
  ];

  return (
    <div className="min-h-dvh bg-app pb-16">
      <header className="no-print sticky top-0 z-30 border-b border-ink/5 bg-white/60 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-4xl items-center gap-3 px-4 sm:px-6">
          <Link href={`/w/${workspaceId}`} className="grid h-9 w-9 place-items-center rounded-full bg-white shadow-clay-sm" aria-label="Back to canvas"><ArrowLeft size={16} weight="bold" /></Link>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-muted">{ws.data?.title}</p>
            <h1 className="truncate font-display text-base font-bold">Session report</h1>
          </div>
          {(sessions.data?.length ?? 0) > 1 && (
            <Select aria-label="Session" className="hidden h-9 max-w-52 text-xs sm:block" value={sessionId} onChange={(e) => router.push(`/w/${workspaceId}/report/${e.target.value}`)}>
              {sessions.data?.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </Select>
          )}
          <Button size="sm" variant="outline" onClick={() => window.print()}><FilePdf size={16} weight="bold" /> <span className="hidden sm:inline">Download PDF</span></Button>
          <UserMenu />
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-4 pt-8 sm:px-6">
        <p className="hidden text-xs font-bold print:block">{APP_NAME} · {ws.data?.title}</p>
        <div>
          <Kicker tone="mint">{session?.state === "stopped" ? "Session complete" : "Session in progress"}</Kicker>
          <h2 className="mt-3 text-balance text-[1.75rem] font-extrabold leading-tight sm:text-[2.25rem]">{session?.title ?? "Session"}</h2>
          <p className="mt-1 text-sm text-muted">{session && `${formatDateTime(session.started_at)} – ${session.ended_at ? formatTime(session.ended_at) : "now"}`}</p>
        </div>

        {!numbers ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 rounded-[24px]" />)}</div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {numbers.map(([k, v]) => (
              <Card key={k} className="rounded-[24px] p-4 shadow-clay-sm">
                <p className="text-xs font-semibold text-muted">{k}</p>
                <p className="tabular mt-2 font-display text-2xl font-extrabold">{v}</p>
              </Card>
            ))}
          </div>
        )}

        {s && s.time_per_site.length > 0 && (
          <Card className="p-5">
            <Heading>Where your time went</Heading>
            <p className="mt-1 text-sm text-muted">Minutes spent on each website in this session.</p>
            <div className="mt-3">
              <ResponsiveContainer width="100%" height={Math.max(160, s.time_per_site.length * 40)}>
                <BarChart layout="vertical" data={s.time_per_site.map((t) => ({ name: t.site.replace(/^www\./, ""), min: Math.max(1, Math.round(t.ms / 60000)) }))} margin={{ left: 0, right: 16 }}>
                  <CartesianGrid stroke="#eceff3" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} unit=" min" />
                  <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 12 }} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#f5f1e8" }} formatter={(v) => [`${v} min`, "Time"]} />
                  <Bar dataKey="min" fill="#ee7048" radius={[0, 8, 8, 0]} maxBarSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        )}

        <Card className="p-6">
          {report.isLoading ? <LoadingBlock label="Loading summary…" /> : !report.data || report.data.status === "failed" ? (
            <EmptyState compact icon={Sparkle} title={report.data?.status === "failed" ? "The summary could not be written" : "No summary yet"} message="The summary is written from the pages you read in this session." action={<Button variant="purple" loading={gen.isPending} onClick={() => gen.mutate()}><Sparkle size={16} weight="fill" /> {report.data?.status === "failed" ? "Try again" : "Write the summary"}</Button>} />
          ) : report.data.status === "generating" ? (
            <LoadingBlock label="Writing the summary…" />
          ) : content && (
            <div className="space-y-6">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <Heading>Summary</Heading>
                  <Button size="xs" variant="ghost" className="no-print" onClick={() => gen.mutate()}>Write again</Button>
                </div>
                <div className="mt-2 space-y-3 text-[15px] leading-relaxed text-ink-soft">
                  {content.summary.split(/\n{2,}/).map((para, i) => <p key={i}>{withCitations(para)}</p>)}
                </div>
              </div>
              {content.key_findings.length > 0 && (
                <div>
                  <Heading>Key points</Heading>
                  <ul className="mt-2 space-y-2">
                    {content.key_findings.map((f, i) => (
                      <li key={i} className="rounded-2xl bg-canvas p-3 text-sm leading-relaxed text-ink-soft">
                        {f.text} {f.refs.map((n) => <span key={n}>{withCitations(`[${n}]`)}</span>)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between gap-2">
            <Heading>Sources</Heading>
            <div className="no-print flex gap-1">{(["md", "bibtex", "json"] as ReferenceFormat[]).map((f) => <Button key={f} size="xs" variant="secondary" onClick={() => void exportRefs(f)}>{f === "md" ? "Text" : f === "bibtex" ? "BibTeX" : "JSON"}</Button>)}</div>
          </div>
          {refs.isLoading ? <LoadingBlock label="Loading sources…" /> : !refs.data?.references.length ? <p className="mt-3 text-sm text-muted">No sources were saved in this session.</p> : (
            <ol className="mt-3 space-y-3">
              {refs.data.references.map((r) => (
                <li key={r.ref_number} className="text-sm">
                  <button className="text-left font-bold hover:text-purple-deep" onClick={() => jump(r.node_id)}>[{r.ref_number}] {r.title}</button>
                  <span className="text-muted"> — {r.site_name ?? r.domain}</span>
                  <a href={r.url} target="_blank" rel="noreferrer" className="block truncate text-xs text-purple-deep">{r.url}</a>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </main>
    </div>
  );
}

export function ReportRoute() {
  const ids = usePathIds(); // /w/<workspaceId>/report/<sessionId>
  return <AuthGate>{ids?.[1] && ids[3] ? <Report workspaceId={ids[1]} sessionId={ids[3]} /> : null}</AuthGate>;
}
