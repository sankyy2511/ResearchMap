---
doc: prd
status: approved
---

# Research Map — Product Requirements

A Chrome extension and web app for people who research in the browser for work. It records the pages they read, explains each page with Google Gemini, groups them on a shared canvas, and checks each page against their goal.
Source: `scope.md > The Unique Kernel`, `scope.md > Who It's For`.

## The Core Journey
1. The person opens the website and creates an account with email and a 6-digit code, or with Google.
2. They see a short page with three steps to install the Chrome extension, and install it.
3. They create a workspace, for example "Choose a CRM". A popup asks if they have a goal. They type "Pick a CRM for our sales team".
4. Gemini rewrites the goal in clear words and lists 3 to 6 key topics. An arrow points to Start Tracking.
5. They click Start Tracking. The web app checks that the extension is connected.
6. They browse as usual. Each page they stay on for 5 seconds appears on the canvas as a card.
7. Shortly after, the card shows Gemini's summary, and the card moves into a named group such as "CRM software".
8. If a page is not part of the goal, the card says "Not related to your goal" and the extension shows a notice with two buttons: go back, or mark as relevant.
9. They click a card to read the summary, key points with exact quotes, the page it was opened from, and the time spent.
10. They click End Session. Gemini writes a report with a short summary, key points, numbered sources and a chart of time per website.
11. They copy a share link and send it to a teammate, who sees the same canvas update live.

Success: the person ends with one report they can share, and does not have to copy notes by hand.

## Screens and Layout
- **Home page** — what the product does, with a screenshot and a Sign in button.
- **Sign up, sign in, forgot password** — simple forms with live password rules.
- **Install the extension** — three short steps and a ZIP download.
- **Workspaces** — a list of workspaces with create, rename, delete and import.
- **Workspace** — the main screen. A top bar with the goal, Start Tracking and Share. The canvas fills the middle. A side panel opens when a card is clicked. Tabs switch between Canvas, List and Timeline.
- **Goal panel** — the goal, how Gemini understood it, time on and off the goal, and off-goal pages with the reason.
- **Conflict Radar** — pairs of sources that disagree.
- **Session report** — one page that can be printed or saved as PDF.
- **Settings** — connect the extension and create tokens for AI assistants.
- **Extension popup** — current workspace, tracking state, pause button.

## Look and Feel
- Calm and friendly, with soft colours and rounded cards.
- Each card looks like a small browser tab with a preview and the title.
- Groups are soft coloured boxes with a name and a page count.
- All text is simple formal English: short sentences, no hard words, no emojis.
- Few buttons on screen at one time.

## Features and Behavior

### Capturing pages
- The extension records only while Start Tracking is on, and never in Incognito.
- A page is added after 5 seconds on screen. Search result pages are not added, but the pages opened from them keep the search words.
- Private sites (email, chat, social media, payments) and pages with a password field are never recorded.
- If the server is down, captures wait and are sent again later.

### Understanding pages
- Gemini decides if a page is research, then writes a 3 to 5 sentence summary, topics and up to 6 key points with exact quotes.
- Pages that are not research go to "Other pages" and are not analysed further.

- As a researcher, I want each page explained in a few sentences so that I do not have to read it again.
  - [x] A new card shows its summary on the map shortly after it is captured, without a page reload
  - [x] The page panel shows key points with an exact quote from the page

### Grouping pages
- Each research page joins a group with related pages. Gemini names the group in 2 to 4 words from all the pages in it.
- Inside a group, pages are shown in the order they were opened, with a number.

### Goal tracking
- When a goal is set, Gemini lists its key topics.
- Each new page is checked against the goal. The check is generous: a wrong warning is worse than a missed one.
- An off-goal page gets a notice in the browser with the reason. The same page does not warn again for 10 minutes.

- As a researcher, I want to know when I drift away from my task so that I can come back to it.
  - [x] Opening an unrelated page shows a notice with a reason
  - [x] "Mark as relevant" removes the off-goal label

### Session report
- When a session ends, Gemini writes 2 or 3 paragraphs and 4 to 7 key points, citing each source by number.
- The report shows the time spent per website and on the goal.

### Sharing
- View-only and edit share links.
- Everyone in the workspace sees new cards, summaries and goal checks at the same time.

### AI assistant access
- A person can connect Gemini CLI or another MCP client with a token from Settings.
- The assistant can create a workspace, set the goal and add sources. Its work goes to a separate "AI Agent" branch until a person copies it to the main canvas.

## States and Boundaries
- **First use** — after sign up, the person sees the install page. In a new workspace, after the goal question, an arrow points to Start Tracking.
- **Extension not installed** — Start Tracking opens a popup with the install steps instead of starting.
- **AI is busy or down** — the page is saved without a summary and analysed again later. The goal check falls back to a local similarity check, so the person is never blocked.
- **Viewer** — a person with a view-only link can look but cannot change anything.
- **What persists** — workspaces, cards, summaries, sessions and reports are saved in the database and are there next time.
- **Deleting** — a workspace cannot be deleted while tracking is on.

## Product Decisions
- Groups instead of lines between pages — lines made the canvas messy and hard to read.
- 5 seconds before a page is added — so pages the person only passes through are not added.
- Generous goal check — a wrong warning annoys the person more than a missed one.
- AI work on its own branch — a person should approve what an AI assistant adds.
- Simple formal English in every AI answer — the product is for everyone, not only experts.

## What We're Building
- Accounts with email code and Google sign-in.
- Chrome extension for capture, time tracking and goal notices.
- Canvas, list and timeline views with named groups.
- Gemini summaries, key points, group names, goal plan, goal check and session report.
- Share links with live updates.
- Conflict Radar, search, export and the MCP server for AI assistants.

## Deferred From the POC
- **Chrome Web Store listing** — the store review takes time; for now the extension is loaded from a ZIP.
- **Team roles across an organisation** — workspace roles (owner, editor, viewer) are enough for now.

## Possible Later Enhancements
- Save reports to Google Docs and Google Drive.
- Read PDFs and videos with Gemini.
- Ask your map: ask a question and Gemini answers from the saved pages, with sources.
- What to read next: Gemini points out what is still missing for the goal and suggests pages.
- Summaries and reports in Hindi and other Indian languages.
- Support for other browsers.

## Non-Goals
- **No mobile app** — research happens on a laptop browser.
- **No tracking without consent** — the extension never records unless Start Tracking is on.
- **The product does not decide who is right** — Conflict Radar shows where sources disagree and what to check, and leaves the decision to the person.

## Open Questions
- None that block the build.
