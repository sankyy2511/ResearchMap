import { WorkspaceRoute } from "./WorkspaceRoute";

// Static hosting builds one page that serves every /w/<id> address; the real ID is read in the browser.
export function generateStaticParams() {
  return [{ workspaceId: "_" }];
}

export default function WorkspacePage() {
  return <WorkspaceRoute />;
}
