# Keystone — Handoff Summary (for new Claude Project)

## What Keystone is
A family habit/task planner with a plan → commit → reward loop. Not a plain checkbox tracker — rewards are always human-granted (parent or self), never automatic, even at partial completion.

## Repo
`vankadn/keystone` (standalone repo, split out of the `nyra-learns` monorepo for portfolio-separation reasons). GitHub Pages enabled.

## Core domain model
- **Habits** (recurring) vs **Tasks** (one-off) are different lifecycle objects. A missed habit is just missed for that day — no carry-forward. An incomplete task persists day to day until done.
- **Checkpoints** group items for a day and carry a reward (fixed at planning time, or "open" — picked from a pool at grant time).
- **Weekly rules** (e.g. read 5/7 days → new book) evaluated separately from daily checkpoints.
- **Multi-person by column, not tab** — every tab has a `personId` column; people share tabs. This keeps the future family calendar view (Phase 9) cheap — filter one log instead of joining N tabs.
- **Profiles/theming** (Phase 8): each person picks a feel-based theme (Playful/Minimal/Warm), done via CSS custom property swaps.
- **New idea, not yet scoped as a phase**: checkpoints (or individual items within them) need a *time-binding mode* — "loose" (do sometime before a deadline, order doesn't matter) vs. "pinned" (specific time). This isn't fixed per person or habit — it flexes by context (school day vs. holiday, workday vs. off day). Likely lives as a property on the checkpoint per-day, with possible per-item overrides. **Needs to be written up as a proper roadmap phase.**

## Architecture
Onion/light-DDD, 3 layers, strict dependency direction (UI → provider, UI → rules; rules depends on nothing):
- `shared/keystone-rules.js` — pure domain logic, zero I/O (`isValidStatusTransition`, `isTaskStale`, `isCheckpointReady`, `canGrantReward`, `resolveOpenRewardChoice`)
- `shared/keystone-provider.js` — data access only, owns the `SHEET_SCHEMA` constant (source of truth over ROADMAP.md prose)
- `app/*.html` — UI, no business logic itself

## Storage: Google Sheets, 8 tabs (all have `personId` column)
`people`, `habits`, `tasks`, `habit_log`, `checkpoints`, `reward_catalog`, `weekly_rules`, `reward_log`. Exact columns are in `SHEET_SCHEMA` in the provider file — treat that as canonical, not this summary.

## Access model
- Anonymous reads via public API key (Sheet must be shared "Anyone with link → Viewer"; key restricted to Sheets API + HTTP referrer)
- Writes via OAuth (Google Identity Services), reusing the same OAuth Client ("Nyra Learns") and Google Cloud project (`nyra-bhajans`) as the Bhajans app, with `.../auth/spreadsheets` scope added
- Sheet is always app-initialized via `initializeSheet(sheetId, accessToken)` — idempotent, creates missing tabs + headers, deletes leftover empty default tabs. **Never hand-create tabs in the Sheets UI.**
- Bring-your-own-sheet via `?sheetId=` URL param (mirrors Bhajans' `?folderId=`), falls back to family default, cached in localStorage

## Live config
- OAuth Client ID: `932543586612-ok5hqlc09t4r0dv22ijsk2n0bkkc9a5o.apps.googleusercontent.com` (shared with Bhajans; has `http://localhost:3000` added to Authorized JavaScript origins for local dev, additive to Bhajans' existing origins)
- Template Sheet ID: `1kEWgsvtnpy4bVQDgBpdiplpuNGVRWNyty6ckMJvI8kk`
- API key: `keystone-read-key` (separate from Bhajans' key, deliberately, for quota/risk isolation) — restricted to Sheets API + HTTP referrer
- `config.local.js` (gitignored) holds `CLIENT_ID`, `SHEET_ID`, `READ_API_KEY`

## Status: Phase 2 complete and verified
Confirmed working end-to-end in a real (non-mock) environment:
- OAuth sign-in works
- `initializeSheet` created all 8 tabs correctly in the live Sheet, removed default `Sheet1`
- Anonymous reads via API key work
- `today.html` correctly handles both "tabs don't exist yet" (400 error) and "tabs exist but empty" (`"No people found"`) states

Three real setup issues were hit and resolved along the way (all now documented in the repo as "common setup gotchas" per the phase-2-close CC prompt): OAuth origin_mismatch (needed localhost added to authorized origins), a false-alarm 403 caused by testing the Sheets API URL via direct browser paste (no referrer sent — always test through the running app instead), and a routing 404 (serving path didn't match the URL tried).

## Not yet started
- **Phase 3**: real write interactivity — checking off habits/tasks/checkpoints, reward granting, OAuth writes going live in the UI (currently only `initializeSheet` writes)
- **Checkpoint time-mode** (loose vs. pinned, context-dependent) — needs to be scoped as a phase
- **Phase 8**: profiles/theming
- **Phase 9**: family calendar view

## Working style notes
- Krishna wants the repo's own `CLAUDE.md` / `ROADMAP.md` to be the living source of truth going forward, kept in sync by him — not this chat's memory. Treat this summary as a snapshot, not an ongoing source.
- CC prompts are the handoff artifact for implementation; this project (chat) is for architecture/scoping/debugging talk-throughs, CC does the actual file changes.
