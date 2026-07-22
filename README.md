# Keystone

A family habit and task planner built around a plan → commit → reward loop.
The name references *The Power of Habit* (cue → routine → reward).

Keystone helps a family plan tomorrow's habits and tasks, track what got
done today, and group completed work into checkpoints that unlock
parent-granted rewards.

## Tech stack

- Vite + React + TypeScript, Tailwind v4 + shadcn/ui
- Google Sheets as the data layer (read/write via the Sheets API)
- Google OAuth for authenticated writes, public API key for anonymous reads
- Hosted on GitHub Pages, deployed via GitHub Actions

## How to Run

Clone the repo, then:

```
npm install
cp .env.local.example .env.local
```

Fill in real values in `.env.local` (`VITE_API_KEY`, `VITE_SHEET_ID`,
`VITE_OAUTH_CLIENT_ID`) — it's gitignored, never commit it. Then:

```
npm run dev
```

Open the printed URL (pinned to `http://localhost:3000/keystone/` — the
dev server's port is fixed in `vite.config.ts` to match the origin
already allowlisted for the API key/OAuth client; other ports will get a
403 from the Sheets API).

**First time on a fresh Sheet:** go to `/setup` first, click **Sign in**,
then **Initialize Sheet** — this creates all the tabs (and deletes the
leftover default "Sheet1" if empty). Safe to re-run any time; it only
adds what's missing, so re-run it again whenever an update adds a new
tab (check CLAUDE.md's Data model for the current full list). There is no
manual tab creation in Google Sheets — the app always owns the sheet
structure.

Then use the nav to get around: **Today** (`/`) for daily habit/task/
class checkboxes, sectioned and drag-reorderable, plus checkpoints (a
small "Adjust today's plan" link on Today jumps into the same arranging
UI as Plan, just pointed at today instead of tomorrow), **Plan Tomorrow**
(`/plan`) for arranging tomorrow's habits/tasks/classes and closing out
the day — it's really a general "plan any date" view (`/plan?date=`),
Nav's link just defaults to tomorrow — **Checkpoints** for grouping
items into a
reward-bearing checkpoint and granting rewards, **Report** for the week's
habit completion/task aging/reward history (read-only, no sign-in
needed), **Habits** and **Classes** for managing those definitions, and
**Setup** for (re-)running Sheet initialization — worth revisiting
whenever you pull an update that adds a new tab, not just once at the
very start.

### Common setup gotchas

- **OAuth `origin_mismatch`**: the OAuth Client ID's "Authorized
  JavaScript origins" (Google Cloud Console) must include whatever origin
  you're actually serving the app from (e.g. `http://localhost:3000`).
  This is separate from the API key's referrer restriction below — fixing
  one does not fix the other.
- **API key referrer testing**: never test a Sheets API URL by pasting it
  directly into the browser address bar — that sends no referrer and will
  always 403 (`API_KEY_HTTP_REFERRER_BLOCKED`) on a referrer-restricted
  key, even when the app itself works fine. Test through the running app
  (a real `fetch()` call from the dev server) instead.
- **Wrong port**: if `npm run dev` can't bind port 3000 (e.g. another
  instance already running), don't just let Vite fall back to a
  different port — it'll 403 against the Sheets API. Free port 3000 first
  (`strictPort: true` in `vite.config.ts` makes Vite fail loudly instead
  of silently picking a different one).

## Status

See [CLAUDE.md](./CLAUDE.md) for architecture, current status, and the
phase roadmap.

## Live app

_Not yet deployed._
