import { InfoPage } from "@/components/site/InfoPage";

export const metadata = { title: "How it works" };

export default function HowItWorksPage() {
  return (
    <InfoPage
      title="How it works"
      intro="Research Map has three parts: a web app where you see your canvas, a browser extension that notices the pages you read, and an AI service that reads each page for you."
      sections={[
        {
          heading: "1. Create a workspace and write your goal",
          text: "A workspace holds all the pages for one research project. When you press Start Tracking, you write what you want to finish in this session, for example: learn the basics of computer networks.",
        },
        {
          heading: "2. Browse as you normally do",
          items: [
            "Install the browser extension once. The web app connects to it by itself.",
            "When you stay on a page for a few seconds, the extension sends the page to your workspace.",
            "Searches, private sites and pages with a password field are never added.",
          ],
        },
        {
          heading: "3. Read your canvas",
          items: [
            "Every page you opened appears as a box in a tree. A page is placed under the page it came from or relates to.",
            "Click a page to read a short summary and the key points.",
            "Click a line between two pages to see why they are connected.",
          ],
        },
        {
          heading: "4. Get a warning when you go off topic",
          text: "A few seconds after you open a page, the app checks it against your goal. If the page is about something else, a small card appears on the page. You can go back, or tell the app that the page is related.",
        },
        {
          heading: "5. Stop and review",
          text: "When you stop tracking, you can create a session report with a summary, the time you spent, and a numbered list of the pages you used.",
        },
      ]}
    />
  );
}
