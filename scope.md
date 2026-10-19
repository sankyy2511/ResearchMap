---
doc: scope
status: approved
---

# Research Map

A Chrome extension and web app that turn the pages you read into one clear, shared map of what you learned.

## The Unique Kernel
A research map that builds itself while you browse. Bookmark and tab tools only save links. Here, each page you stay on becomes a card with a short summary written by Google Gemini, similar pages are grouped under a clear name, and if you set a goal, you get a gentle notice when a page is not part of it.

## Who It's For
A person who has to research something for work and then explain the result. For example, someone on a small sales team who must compare five CRM tools and tell the team which one to pick.

Today they open so many tabs that the tab titles shrink to two letters, so they cannot tell which tab is which. They forget which page said what, drift to pages that are not related to the task, and lose everything when the tabs close. To share the result, they copy notes by hand and send a long list of links.

## The Core Loop
1. Open a workspace for the task and, if they want, type a goal.
2. Click Start Tracking and browse as usual.
3. Watch each page appear on the canvas with its summary, inside a named group.
4. Get a notice when a page is off the goal, and go back or mark it as relevant.
5. End the session and read a short report with numbered sources.

They come back because the canvas keeps everything they read, and the next research task starts from a clean workspace.

## Inspiration & Identity
- Calm, friendly and clear. It should feel like a tidy desk, not a busy dashboard.
- Soft colours, rounded cards, and simple formal English with no hard words.
- Cards look like small browser tabs, so people know at once that each card is a page.

## Why This Matters to the Learner
This is our own problem. In our own browser, with many tabs open, the titles were cut to two letters and we could not find the page we needed. We forgot what each page said, drifted to unrelated pages, and lost everything when the tabs closed. We want a tool that keeps our research for us, without extra work, and lets us share it with our team.

## What "Working" Looks Like
A person creates a workspace called "Choose a CRM", sets the goal "Pick a CRM for our sales team", clicks Start Tracking, and opens a few pages about CRM tools.

Within seconds each page shows up on the canvas with a summary, and the pages are grouped under a name such as "CRM software". They open a page about football scores and a notice says the page is not related to the goal. They end the session and get a report with numbered sources.

The "oh, that's cool" moment: the canvas fills up and organises itself while they read.

## The POC Boundary
- Chrome extension that records a page after 5 seconds on screen, only while tracking is on.
- Gemini summary, key points and topics for each page.
- Pages grouped into named clusters on a visual canvas.
- Goal plan, goal check and off-goal notice.
- Session report with numbered sources.
- Sign in, workspaces, and a share link so a teammate can see the same canvas.
- Extras we added once the core loop worked: Conflict Radar (sources that disagree), export, and an MCP server so an AI assistant such as Gemini CLI can research into the same canvas.

## Later
- Publish the extension on the Chrome Web Store for one-click install.
- Save reports directly to Google Docs and Google Drive.
- Read PDFs and videos, not only web pages.
- Ask your map: ask a question and Gemini answers from the saved pages, with sources.
- What to read next: Gemini points out what is still missing for the goal.
- Summaries and reports in Hindi and other Indian languages.
- Team roles managed at the organisation level.

## Explicitly Cut
- **Mobile app** — research happens on a laptop browser, so a phone app adds work without helping the core loop.
- **Browsers other than Chrome** — one browser is enough to prove the idea.
- **Lines between every related page** — they made the canvas messy, so named groups are used instead.
- **Paid plans and billing** — not needed to prove that the idea works.
