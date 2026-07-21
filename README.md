# Keystone

A family habit and task planner built around a plan → commit → reward loop.
The name references *The Power of Habit* (cue → routine → reward).

Keystone helps a family plan tomorrow's habits and tasks, track what got
done today, and group completed work into checkpoints that unlock
parent-granted rewards.

## Tech stack

- Static HTML/JS, no build tooling
- Google Sheets as the data layer (read/write via the Sheets API)
- Google OAuth for authenticated writes, public API key for anonymous reads
- Hosted on GitHub Pages

## How to Run

Clone the repo, then serve it from a local static server — ES modules
(`import`/`export` in `shared/keystone-provider.js`) don't load over a
`file://` URL, so opening the HTML directly won't work. From the repo root:

```
npx serve .
```

or

```
python3 -m http.server
```

Then open `http://localhost:<port>/app/phase1-test.html`.

**What to expect (Phase 1):** an open browser console showing mock data
logged from each provider function (people, habits, tasks, checkpoints,
rewards, etc.). There's no visual UI yet — `phase1-test.html` is a scratch
harness, not the app.

This section will grow with each phase (Phase 2 adds real Google Sheets
setup steps, Phase 3 adds OAuth setup, etc.) — treat it as the living
"how do I run this" doc, not something written once.

**Phase 2 (app-driven Sheet init + real reads):** copy
`app/config.local.example.js` to `app/config.local.js` and fill in your
real `apiKey`, `sheetId`, and `oauthClientId` — `app/config.local.js` is
gitignored, never commit it. Serve the repo as above, then:

1. Open `app/setup.html` first, click **Sign in**, then **Initialize
   Sheet** — this creates the 8 tabs (and deletes the leftover default
   "Sheet1" if empty). Safe to re-run any time; it only adds what's
   missing. There is no manual tab creation in Google Sheets — the app
   always owns the sheet structure.
2. Then open `app/today.html` to see today's habits, tasks, and
   checkpoints read live from the configured Sheet.

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
  (a real `fetch()` call from a page served via a local static server)
  instead.
- **Routing**: confirm the actual served path (e.g. `/app/today.html`,
  not `/today`) matches your static server's routing before assuming a
  Sheets/API bug when you actually just have a 404.

## Status

Early scaffolding — see [CLAUDE.md](./CLAUDE.md) for architecture, status,
and the phase roadmap.

## Live app

_Not yet deployed._
