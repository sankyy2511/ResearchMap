import { ReportRoute } from "./ReportRoute";

// Static hosting builds one page that serves every report address; the real IDs are read in the browser.
export function generateStaticParams() {
  return [{ workspaceId: "_", sessionId: "_" }];
}

export default function ReportPage() {
  return <ReportRoute />;
}
