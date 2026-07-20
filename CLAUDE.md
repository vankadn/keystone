# Keystone — Architecture & Design Decisions

## Purpose
Family habit/task planner with a plan → commit → reward loop.
Users: Nyra, Krishna, wife (extensible to bring-your-own-Sheet for others).

## Stack
- Static HTML/JS, GitHub Pages hosting (no backend server)
- Google Sheets as the data layer (not Drive-file-JSON, not folder-schema)
- Google OAuth (shared client from nyra-bhajans Cloud project) for writes
- Public API key for anonymous reads (link-shared Sheets)

## Data model
Habits (recurring, daily-reset, missed ≠ carried forward) vs Tasks
(persistent until done, does carry forward) — deliberately different
lifecycle objects, not the same row type. 8 tabs total regardless of how
many people share a sheet — every tab has a `personId` column, filtered
rather than split one-tab-per-person (this is what makes a future
family/aggregate view cheap: filter one log, don't join N tabs).

`SHEET_SCHEMA` in `shared/keystone-provider.js` is the single source of
truth for tab/column structure. ROADMAP.md's schema doc mirrors it for
readability — if they ever disagree, the code wins. Sheet structure is
always app-initialized via `initializeSheet()` (see Provider below),
never hand-edited in Google Sheets.

## Reward model
Checkpoints group items and carry a reward (fixed or open/pick-from-pool).
Rewards are parent-GRANTED, never automatic — a checkpoint hitting 100%
just surfaces "ready," a human decides when to grant it (including
partial-completion judgment calls).

## Current phase
Phase 3 (OAuth write interactivity: checking off habits/tasks, plus a
minimal Add Person slice pulled forward from Phase 8) — see ROADMAP.md
for full phase breakdown and the Phase 3 audit note on why Add Person
landed early. Checkpoint reward-granting is still Phase 5, not Phase 3.
Add Person is verified end-to-end against the live template Sheet
(write, then read back live via redirect). Habit/task checkbox writes
and silent-refresh-on-repeat-visit are code-complete but not yet
verified live — see ROADMAP.md before marking this phase complete.

## Provider
`shared/keystone-provider.js` reads are wired to the real Sheets API as of
Phase 2 (anon, via API key). Writes now live as of Phase 3:
`initializeSheet(sheetId, accessToken)` creates/verifies the 8 tabs from
`SHEET_SCHEMA` and deletes an empty leftover default tab (idempotent,
safe to re-run); `setHabitStatus` appends to `habit_log` (append-only —
past rows are never edited); `setTaskStatus` mutates the matching `tasks`
row in place; `addPerson(name, theme)` appends a row to `people`
(client-generated `personId`, no avatar yet — full profile creation is
Phase 8). `upsertCheckpoint`/`grantReward` remain mock/in-memory until
Phase 4/5. All OAuth writes read their token from a module-level var set
via `setAccessToken()` — token acquisition itself lives in
`shared/keystone-auth.js` (silent-refresh-first, visible sign-in
fallback), never in the provider. Function signatures and return shapes
have held steady since the Phase 1 mock contract — no caller changes
expected going forward.

## Architecture layers
Onion boundary, three layers:
- **Domain** (`shared/keystone-rules.js`) — pure functions: habit/task
  lifecycle rules, checkpoint completion logic. No I/O, no DOM, no
  network, zero imports from the other two layers.
- **Data** (`shared/keystone-provider.js`) — knows how to fetch/store rows
  matching the Sheet schema. No business logic (never decides what
  "complete" or "stale" means).
- **UI** (`app/*.html`) — calls provider for data, calls rules for
  decisions, renders. No business logic of its own.

Dependency direction: UI -> provider, UI -> rules, provider -> rules.
Never rules -> provider, never rules -> UI.

## Conventions
- CC prompts are the implementation handoff artifact; scoping happens
  in chat first
- Every CC prompt ends with an instruction to update this file
- Config/data-driven where possible — avoid one-off logic per habit/task
