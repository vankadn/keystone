# Keystone — Architecture & Design Decisions

## Purpose
Family habit/task planner with a plan → commit → reward loop.
Users: Nyra, Krishna, wife (extensible to bring-your-own-Sheet for others).

## Stack
- Static HTML/JS, GitHub Pages hosting (no backend server)
- Google Sheets as the data layer (not Drive-file-JSON, not folder-schema)
- Google OAuth (shared client from nyra-bhajans Cloud project) for writes
- Public API key for anonymous reads (link-shared Sheets)

## Config
- OAuth Client ID: `932543586612-ok5hqlc09t4r0dv22ijsk2n0bkkc9a5o.apps.googleusercontent.com`
  — shared with the Bhajans app / `nyra-bhajans` Cloud project;
  `http://localhost:3000` is added to Authorized JavaScript origins for
  local dev, additive to Bhajans' existing origins.
- Template Sheet ID: `1kEWgsvtnpy4bVQDgBpdiplpuNGVRWNyty6ckMJvI8kk`
- API key: `keystone-read-key` — separate from Bhajans' key deliberately,
  for quota/risk isolation; restricted to Sheets API + HTTP referrer.
- `app/config.local.js` (gitignored — copy from `app/config.local.example.js`)
  holds `apiKey`, `sheetId`, `oauthClientId`.

## Data model
Habits (recurring, daily-reset, missed ≠ carried forward) vs Tasks
(persistent until done, does carry forward) — deliberately different
lifecycle objects, not the same row type. 8 tabs total regardless of how
many people share a sheet — every tab has a `personId` column, filtered
rather than split one-tab-per-person (this is what makes a future
family/aggregate view cheap: filter one log, don't join N tabs).

`SHEET_SCHEMA` in `shared/keystone-provider.js` is the single source of
truth for tab/column structure. Sheet structure is always app-initialized
via `initializeSheet()` (see Provider below), never hand-edited in Google
Sheets.

## Reward model
Checkpoints group items and carry a reward (fixed or open/pick-from-pool).
Rewards are parent-GRANTED, never automatic — a checkpoint hitting 100%
just surfaces "ready," a human decides when to grant it (including
partial-completion judgment calls).

## Provider
`shared/keystone-provider.js` reads are wired to the real Sheets API as of
Phase 2 (anon, via API key). Writes: `initializeSheet(sheetId, accessToken)`
creates/verifies the 8 tabs from `SHEET_SCHEMA` and deletes an empty
leftover default tab (idempotent, safe to re-run); `setHabitStatus`
appends to `habit_log` (append-only — past rows are never edited);
`setTaskStatus`/`addTask` mutate/append `tasks` rows; `addPerson(name,
theme)` appends to `people` (client-generated `personId`, no avatar yet
— full profile creation is Phase 8); `upsertCheckpoint` upserts a
`checkpoints` row (auto-generates `checkpointId` if the caller omits
one, same as `addPerson`/`addTask`); `addReward`/`updateReward`/
`deleteReward` are basic CRUD against `reward_catalog`; `grantReward`
appends a `reward_log` row and flips the matching checkpoint's status to
`granted`; `getHabitLogRange(personId, from, to)` backs the report page's
multi-day read (still just filtering by caller-given range, not deciding
what the range should be — that judgment stays in `app/report.html`).
All OAuth writes read their token from a module-level var set via
`setAccessToken()` — token acquisition itself lives in
`shared/keystone-auth.js` (silent-refresh-first, visible sign-in
fallback), never in the provider. Function signatures and return shapes
have held steady since the Phase 1 mock contract — no caller changes
expected going forward.

## Weekly rule metric grammar
`weekly_rules.metric` is a free-text Sheet cell with one supported
grammar (parsed in `shared/keystone-rules.js`'s `evaluateWeeklyRule`):
`"<habitId>:done>=<N>/<M>"`, e.g. `"h3:done>=5/7"` — habitId must have
>= N `'done'` `habit_log` rows within a **rolling** M-day window ending
on the evaluation date (not calendar Mon–Sun, so evaluation never jumps
discontinuously at a week boundary). Report habit-completion-rate math
uses the same rolling-window convention. There's currently no UI to
create `weekly_rules` rows — Phase 6 only builds evaluation, not CRUD —
so a row has to be added by hand in the Sheet for now (not a "manual
Sheet edit" of *structure*, just row data, same as any other content).

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
- `CLAUDE.md` is the sole architecture/status/roadmap doc — `README.md`
  is run/setup instructions only. There is no separate ROADMAP.md or
  handoff-summary doc anymore; don't recreate that split.

## Status
Phases 0–6 are code-complete. Only Phase 2 (Sheet init + anonymous reads)
and Add Person (pulled forward from Phase 8 into Phase 3) are verified
against the live template Sheet. Everything else built since — habit/task
checkbox writes, silent-refresh OAuth, Plan Tomorrow's close-out action,
checkpoint creation, reward catalog CRUD, the grant flow, and weekly rule
evaluation/report — is written and syntax-checked but not yet driven in a
real browser against the real Sheet. Don't treat any phase past Phase 2 +
Add Person as done until it's actually been clicked through.

## Roadmap
- **Phase 0 — Manual setup.** Repo created, Pages enabled, Sheets API
  enabled on `nyra-bhajans`, template Sheet created. Done.
- **Phase 1 — Provider abstraction + Sheet schema.** `SHEET_SCHEMA`
  defined (8 tabs — see Data model above), mock data only, no UI. Done.
- **Phase 2 — App-driven Sheet init + real read wiring.** `initializeSheet`
  creates/verifies the 8 tabs; anonymous reads via API key; read-only
  Today screen. Done, verified live.
- **Phase 3 — OAuth writes + Today interactivity.** Silent-refresh-first
  sign-in, habit/task checkboxes writing to `habit_log`/`tasks`,
  `body.anon` write gating, plus Add Person (pulled forward from Phase
  8: name + theme only, no avatar/edit/delete). Code-complete.
- **Phase 4 — Plan Tomorrow + lifecycle rules.** Habits palette, open
  tasks, one-off task add, close-out-day action (explicitly logs
  unlogged habits as `'missed'`). Code-complete.
- **Phase 5 — Checkpoints + reward catalog + grant flow.** Group habits/
  tasks into a checkpoint with a reward (fixed or open/pool); reward
  catalog CRUD; grant action available at any completion %. Code-complete.
- **Phase 6 — Weekly rules + reports.** `evaluateWeeklyRule` (see grammar
  above); week report — habit completion %, task aging, reward history —
  computed client-side, no new tabs/columns. Code-complete.
- **Phase 7 — Bring-your-own-sheet + polish.** `?sheetId=` paste-URL flow
  with validation and friendly errors; publish the template Sheet link
  in-app; a final architecture pass on this file.
- **Phase 8 — Profiles + theming.** Profile creation flow (name, avatar,
  theme picker); theme presets are feel-based, not demographic-locked
  (Playful/Minimal/Warm — anyone picks whichever fits); implemented as
  CSS custom property swaps, not separate stylesheets/builds; visual
  theme only, no per-profile layout changes.
- **Phase 9 — Family calendar view.** Aggregate day/week view across all
  profiles' plans/habits/tasks side by side, computed purely from
  existing tabs filtered across `people` — view-only (switch profile to
  edit a specific person's plan).

**Out of scope for the entire roadmap**: public/verified OAuth (Testing
mode + Test Users list only), notifications/reminders, a native/mobile
wrapper (web only).

## Future scope / backlog
Ideas that exist but haven't been shaped into a roadmap phase yet —
nothing in this section is "next up" the way roadmap phases are.

- **Checkpoint time-binding mode**: checkpoints (or individual items
  within them) need a *time-binding mode* — "loose" (do sometime before
  a deadline, order doesn't matter) vs. "pinned" (specific time). This
  isn't fixed per person or habit — it flexes by context (school day vs.
  holiday, workday vs. off day). Likely lives as a property on the
  checkpoint per-day, with possible per-item overrides. Needs to be
  written up as a proper roadmap phase.
