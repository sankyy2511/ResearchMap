import { JoinRoute } from "./JoinRoute";

// Static hosting builds one page that serves every /join/<token> address; the token is read in the browser.
export function generateStaticParams() {
  return [{ token: "_" }];
}

export default function JoinPage() {
  return <JoinRoute />;
}
