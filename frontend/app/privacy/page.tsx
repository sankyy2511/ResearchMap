import { InfoPage } from "@/components/site/InfoPage";

export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <InfoPage
      title="Privacy"
      intro="Research Map only reads pages while you are tracking, and it keeps private sites out. This page explains exactly what is collected and who can see it."
      sections={[
        {
          heading: "When the extension reads pages",
          items: [
            "Only after you press Start Tracking, and not while tracking is paused.",
            "Never in private (incognito) windows.",
            "Never on your own computer's local addresses.",
          ],
        },
        {
          heading: "Pages that are never read",
          items: [
            "Sites on your private list. It starts with email, chat, social media and payment sites, and you can change it.",
            "Pages with a visible password field.",
            "Search result pages. Only the pages you open from them are added.",
          ],
        },
        {
          heading: "What is sent to the AI",
          text: "To write a summary and to check a page against your goal, the address, title and text of the page are sent to an AI model. Nothing else from your browser is sent.",
        },
        {
          heading: "Who can see your work",
          text: "Only you and the people you invite to a workspace. Other members cannot see which pages you checked against your own goal.",
        },
        {
          heading: "Your control",
          items: [
            "You can stop tracking at any time.",
            "You can delete any page from your canvas.",
            "You can export your workspace.",
          ],
        },
      ]}
    />
  );
}
