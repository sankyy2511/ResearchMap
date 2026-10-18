import { InfoPage } from "@/components/site/InfoPage";

export const metadata = { title: "Features" };

export default function FeaturesPage() {
  return (
    <InfoPage
      title="Features"
      intro="Everything in Research Map is built for one purpose: to help you finish your research without losing your way."
      sections={[
        {
          heading: "Daily goal",
          text: "Write your goal when you start. The app reads short goals using the name of your workspace, so \"cn\" in a networks workspace means computer networks.",
        },
        {
          heading: "Off-topic warning",
          text: "If a page is not about your goal, a warning card appears on that page. Pages outside your goal are greyed out on your canvas, so you can still see where your time went.",
        },
        {
          heading: "One canvas for all your tabs",
          text: "Your pages appear as a tree. Each line says in one word how two pages are related, and a click shows the reason in a plain sentence.",
        },
        {
          heading: "Page summaries",
          text: "Every page gets a short summary and a list of key points, so you can remember what it said without opening it again.",
        },
        {
          heading: "Notes",
          text: "Add your own notes to any page.",
        },
        {
          heading: "Session report",
          text: "After a session, create a report with a summary, the time you spent on your goal and on other pages, and a numbered list of the pages you used.",
        },
        {
          heading: "Share and export",
          items: [
            "Invite other people to a workspace as viewers or editors.",
            "Export your workspace to keep a copy.",
          ],
        },
        {
          heading: "Use with an AI assistant",
          text: "You can connect an AI assistant to your workspace. Pages it adds are kept on a separate branch, so they never mix with your own pages.",
        },
      ]}
    />
  );
}
