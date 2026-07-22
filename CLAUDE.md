# Keystone — Architecture & Design Decisions

## Purpose
Family habit/task planner with a plan → commit → reward loop.
Users: Nyra, Krishna, wife (extensible to bring-your-own-Sheet for others).

## Stack
- Vite + React + TypeScript (`src/`), Tailwind v4 + shadcn/ui (Base UI +
  Nova preset), `react-router-dom` for client-side routing. Migrated from
  the original static-HTML/vanilla-JS multi-page app one page at a time,
  verifying each against the live Sheet before deleting its static
  predecessor — the old `app/*.html` tree and top-level `shared/` are
  gone now that every page has a React equivalent.
- Google Sheets as the data layer (not Drive-file-JSON, not folder-schema)
- Google OAuth (shared client from nyra-bhajans Cloud project) for writes
- Public API key for anonymous reads (link-shared Sheets)
- GitHub Pages hosting via GitHub Actions (`.github/workflows/deploy.yml`
  builds `dist/` and deploys it on push to `main`). Pages "Source" still
  needs a one-time flip to "GitHub Actions" in repo settings — not done
  yet, nothing is deployed.

## Config
- OAuth Client ID: `932543586612-ok5hqlc09t4r0dv22ijsk2n0bkkc9a5o.apps.googleusercontent.com`
  — shared with the Bhajans app / `nyra-bhajans` Cloud project;
  `http://localhost:3000` is added to Authorized JavaScript origins for
  local dev, additive to Bhajans' existing origins.
- Template Sheet ID: `1kEWgsvtnpy4bVQDgBpdiplpuNGVRWNyty6ckMJvI8kk`
- API key: `keystone-read-key` — separate from Bhajans' key deliberately,
  for quota/risk isolation; restricted to Sheets API + HTTP referrer.
- `.env.local` (gitignored — copy from `.env.local.example`) holds
  `VITE_API_KEY`, `VITE_SHEET_ID`, `VITE_OAUTH_CLIENT_ID`. `src/main.tsx`
  reads these via `import.meta.env` and assigns them to
  `window.KEYSTONE_CONFIG` before anything else renders —
  `src/shared/*.js` itself is unchanged, still just reading that global.
- Dev server is pinned to port 3000 (`vite.config.ts`) to match the
  origin already allowlisted above — confirmed empirically that Vite's
  default port (5173) gets a 403 from the Sheets API key.

## Data model
Habits (recurring, daily-reset, missed ≠ carried forward) vs Tasks
(persistent until done, does carry forward) vs Classes (recurring,
weekday+time-bound, not daily-reset — see Phase 10 below for why this is
its own entity rather than a Habit field) — three deliberately different
lifecycle objects, not the same row type. 12 tabs total regardless of how
many people share a sheet — every tab has a `personId` column, filtered
rather than split one-tab-per-person (this is what makes a future
family/aggregate view cheap: filter one log, don't join N tabs).

`SHEET_SCHEMA` in `src/shared/keystone-provider.js` is the single source of
truth for tab/column structure. Sheet structure is always app-initialized
via `initializeSheet()` (see Provider below), never hand-edited in Google
Sheets.

`habits.active` gates visibility, not existence — deactivating a habit
(via `/habits`) hides it from Today/Plan Tomorrow without touching its
`habit_log` history, since that history is append-only and a hard delete
would orphan past rows' `habitId` reference. `habit_log.status` has three
values now: `'done'`, `'missed'` (both existing), and `'skipped'` — set at
*plan* time from Plan Tomorrow (not close-out time) when a habit
legitimately doesn't apply to a given day. `'skipped'` is neutral in
rolling-window math (weekly rules, Report's completion rate) — it's
excluded from the window's effective day-count rather than counted as a
compliance failure the way `'missed'` is. See Weekly rule metric grammar
below for the exact mechanics.

`classes`/`class_log` (Phase 10) follow the same active-flag/append-only-
log conventions as `habits`/`habit_log`, but are a distinct pair of tabs,
not reused ones — see Phase 10 in the Roadmap for the full DDD reasoning
on why Classes aren't just Habits with extra columns.

`day_sections`/`day_plan_items` (Phase 11) are config-driven per-person
day-arrangement, not history — see Phase 11 in the Roadmap for the full
model. `day_sections` (`sectionId`, `personId`, `name`, `sortOrder`) is
plain per-person config, same "config over one-off logic" convention as
everything else; nothing in the domain/provider logic hardcodes the
default count of 3 (Morning/Afternoon/Evening) — that's seed data only,
the user can add/rename/reorder/delete beyond it. `day_plan_items`
(`personId`, `date`, `itemType`, `itemId`, `sectionId`, `itemSortOrder`)
is which section a specific habit/task/class instance sits in on a given
date, and its order within that section — separate from the
habits/tasks/classes *definition* tabs (those stay definitional: what
recurs) and NOT append-only like `habit_log`/`class_log` (this is current
placement, not history — rows mutate in place as the user drags/
reassigns, via `upsertDayPlanItem`'s composite personId+date+itemType+
itemId match).

**Habits vs. Tasks/Classes are deliberately asymmetric on section
mutability** (amendment, still Phase 11, landed before any calendar-view
phase — important, since a calendar view built on the wrong assumption
here would need redoing): `habits` itself carries a `sectionId` column —
a habit's **fixed home section**, set via `/habits`, required at creation.
This is a property of the habit *definition*, exactly like `label` or
`active`, not a per-day choice. Tasks and Classes have no such column;
their section is a free per-day choice living only in `day_plan_items`,
same as originally scoped. The rule this encodes: Habits already have
less daily flexibility than Tasks (see the lifecycle split at the top of
this section — daily-reset, missed ≠ carried forward) — order within a
section is still free to change day to day, but *which* section a habit
lives in is not a daily decision, it's a trait of the habit. Enforced in
`groupItemsBySections` (`keystone-rules.js`): for a `'habit'` item, the
section always comes from `item.sectionId` (the habit's own field) —
a `day_plan_items` row for a habit, if one exists, only ever supplies
`itemSortOrder` (position within that fixed section), its own `sectionId`
is ignored entirely if present. `DayPlanBoard`
(`src/components/DayPlanBoard.tsx`) enforces the same rule on the drag
side: a habit dropped on any section other than the one it's currently
grouped under (which is always its fixed home, per the rule above) is a
silent no-op — no `upsertDayPlanItem` call, item snaps back — while
reordering within its own section persists normally. Other sections dim
while dragging a habit as a visual cue that they're not valid targets.

## Reward model
Checkpoints group items and carry a reward (fixed or open/pick-from-pool).
Rewards are parent-GRANTED, never automatic — a checkpoint hitting 100%
just surfaces "ready," a human decides when to grant it (including
partial-completion judgment calls). `isCheckpointReady` (in
`keystone-rules.js`) returns `false` once `checkpoint.status === 'granted'`,
regardless of item completion — "ready to grant" is a call-to-action, not
a completion readout, so it must stop showing once already granted (was a
live bug: it only ever checked item completion, so granted checkpoints
kept showing "[ready to grant]" next to "Already granted" forever).

## Provider
`src/shared/keystone-provider.js` reads are wired to the real Sheets API
as of Phase 2 (anon, via API key). Every tab-level read (`getPeople`,
`getHabits`, etc.) still calls its own `fetchRawRows(tab)`, but that
function now coalesces every call issued within the same microtask tick
into one `spreadsheets.values:batchGet` request instead of firing a
separate `spreadsheets.values.get` per tab — a page's
`Promise.all([provider.getX(), provider.getY(), ...])` used to mean N
separate HTTP reads (5-6 on Today/Checkpoints), each counted individually
against Sheets' anonymous-read quota (`ReadRequestsPerMinutePerUser`,
60/min); batchGet counts as one regardless of range count. Added after
hitting a live 429 `RESOURCE_EXHAUSTED` during ordinary manual testing —
normal nav between a couple of pages was enough to add up, so this isn't
an edge case, it was the default page-load shape. Callers are unaffected
(`getPeople()` etc. keep their exact signatures/return shapes); the
batching is an internal `fetchRawRows`/`flushBatch` implementation
detail. Writes: `initializeSheet(sheetId,
accessToken)` creates/verifies every tab in `SHEET_SCHEMA` (12 currently,
see Data model — deliberately not hardcoded here since it grows with the
schema) and deletes
an empty leftover default tab (idempotent, safe to re-run); `setHabitStatus`
appends to `habit_log` (append-only — past rows are never edited, now also
used with status `'skipped'` from Plan Tomorrow at plan time, not just
`'done'`/`'missed'`); `setTaskStatus`/`addTask` mutate/append `tasks`
rows; `addHabit(personId, label, sectionId)`/`updateHabit(habitId, {label,
sectionId})`/`setHabitActive(habitId, active)` are `habits` CRUD
(client-generated `habitId`, same generator as `addPerson`/`addTask`;
`updateHabit`/`setHabitActive` each re-fetch the existing row first so
they only touch the field(s) they're asked to change, same pattern as
`updateReward`/`updateClass`). `sectionId` on `addHabit`/`updateHabit` is
the Phase 11 amendment (see Data model above) — `updateHabit`'s signature
changed from `(habitId, label)` to `(habitId, {label, sectionId})` to
accommodate it, an intentional break of the "no caller changes expected"
Phase 1 contract, same kind of documented exception as
`keystone-auth.js`'s `getCachedToken()` addition above;
`addPerson(name, theme)` appends to `people` (client-generated `personId`,
no avatar yet — full profile creation is Phase 8); `upsertCheckpoint` upserts a
`checkpoints` row (auto-generates `checkpointId` if the caller omits
one, same as `addPerson`/`addTask`); `addReward`/`updateReward`/
`deleteReward` are basic CRUD against `reward_catalog`; `grantReward`
appends a `reward_log` row and flips the matching checkpoint's status to
`granted`; `getHabitLogRange(personId, from, to)` backs the report page's
multi-day read (still just filtering by caller-given range, not deciding
what the range should be — that judgment stays in `src/pages/Report.tsx`).
`addClass(personId, name, daysOfWeek, startTime, durationMinutes)`/
`updateClass(classId, {name, daysOfWeek, startTime, durationMinutes})`/
`setClassActive(classId, active)` are `classes` CRUD, same
generate-id/re-fetch-existing-row pattern as the habit functions above;
`logClassStatus(classId, personId, dateISO, status, options)` appends to
`class_log` (append-only, mirrors `setHabitStatus`) — `options.skippedBy`
defaults to `'student'` whenever `status === 'skipped'` and no override is
given, `options.rescheduledTo` is only meaningful when
`status === 'rescheduled'`; `getClasses`/`getClassLog`/`getClassLogRange`
are the matching reads, `getClasses` parsing `daysOfWeek` (comma-list,
same convention as `itemIds`/`tags`) and `durationMinutes` (number) on
the way out.
`addDaySection(personId, name, sortOrder)`/`updateDaySection(sectionId,
{name, sortOrder})`/`deleteDaySection(sectionId)` are `day_sections` CRUD,
same pattern as the habit/class functions above — `deleteDaySection`
deletes only the section row itself, no cascade into `day_plan_items`
(see Data model above for why that's safe: orphaned items self-heal on
read via `groupItemsBySections`). `upsertDayPlanItem(personId, dateISO,
itemType, itemId, sectionId, itemSortOrder)` upserts a `day_plan_items`
row matched on the composite `personId`+`date`+`itemType`+`itemId` (not a
single ID column, hence not reusing the generic `upsertRow` helper);
`getDaySections`/`getDayPlan` are the matching reads. `addPerson` seeds
each new person with the 3 default day sections immediately (see Data
model); `initializeSheet` additionally backfills default sections for any
existing person who has none yet (idempotent — skips anyone who already
has at least one `day_sections` row), catching people created before this
feature existed.
All OAuth writes read their token from a module-level var set via
`setAccessToken()` — token acquisition itself lives in
`src/shared/keystone-auth.js`, never in the provider. Function signatures
and return shapes have held steady since the Phase 1 mock contract — no
caller changes expected going forward.

Every page now calls `requestSignIn` from an explicit "Sign in" click
only. `keystone-auth.js` still exports `requestSilentToken`, but no page
auto-invokes it on load anymore — it was found to pop a visible Google
login window in practice rather than staying invisible (modern browsers'
third-party-cookie restrictions break GIS's silent flow), which was
disruptive on every single page visit. If silent re-auth is revisited,
that's the reason it was pulled, not an oversight.

`keystone-auth.js` caches `{ accessToken, expiresAt }` to `sessionStorage`
(key `keystone.accessToken`) on every successful sign-in — `sessionStorage`
rather than `localStorage` deliberately, so a cached token never outlives
the browser session/tab. That cache alone wasn't enough to keep pages
signed in, though: each page (`Today`/`PlanTomorrow`/`Checkpoints`/`Setup`)
holds its own local `isAuthed` (or, for Setup, `accessToken`) React state,
which used to start `false`/`null` on every mount with nothing reading the
cache back — so react-router `<Link>` nav between pages (which Nav.tsx
already used) and a hard refresh both left the token itself intact
(module-level in provider.js, or still sitting in sessionStorage) while
the UI kept showing "Sign in" and hiding write controls. Fixed by adding
`getCachedToken()` to `keystone-auth.js` — a synchronous sessionStorage
read only, no GIS call — and having each page call it in a mount-time
`useEffect` to rehydrate `provider.setAccessToken()`/local state when a
non-expired token is found. Falls back to "Sign in" exactly as before if
the cache is empty or expired; does not call `requestSilentToken` or any
other GIS flow.

## Weekly rule metric grammar
`weekly_rules.metric` is a free-text Sheet cell with one supported
grammar (parsed in `src/shared/keystone-rules.js`'s `evaluateWeeklyRule`):
`"<habitId>:done>=<N>/<M>"`, e.g. `"h3:done>=5/7"` — habitId must have
>= N `'done'` `habit_log` rows within a **rolling** M-day window ending
on the evaluation date (not calendar Mon–Sun, so evaluation never jumps
discontinuously at a week boundary). Report habit-completion-rate math
uses the same rolling-window convention. There's currently no UI to
create `weekly_rules` rows — Phase 6 only builds evaluation, not CRUD —
so a row has to be added by hand in the Sheet for now (not a "manual
Sheet edit" of *structure*, just row data, same as any other content).

`'skipped'` `habit_log` rows (see Data model above) are neutral in this
math, in both `evaluateWeeklyRule` and `computeHabitCompletionRate`: they
never count toward the `'done'` count, but the effective day-count they're
measured against (M for weekly rules, the completion-rate denominator for
Report) shrinks by the skipped count within the window too — capping what's
required at whatever's actually left to evaluate. Without this, a habit
legitimately paused for a few days (travel, illness) would read identically
to one genuinely missed on those days, which defeats the point of having a
distinct `'skipped'` status. The two functions compute this independently
but with the same logic, deliberately kept in sync — see the comments at
each call site if one changes without the other.

## Architecture layers
Onion boundary, three layers:
- **Domain** (`src/shared/keystone-rules.js`) — pure functions: habit/task
  lifecycle rules, checkpoint completion logic. No I/O, no DOM, no
  network, zero imports from the other two layers.
- **Data** (`src/shared/keystone-provider.js`) — knows how to fetch/store
  rows matching the Sheet schema. No business logic (never decides what
  "complete" or "stale" means).
- **UI** (`src/pages/*.tsx`, routed via `react-router-dom` in
  `src/App.tsx`) — calls provider for data, calls rules for decisions,
  renders. No business logic of its own. `src/components/Nav.tsx` is the
  shared cross-page nav, now including `/setup` (reversed from an earlier
  "deliberately not in daily nav, one-time bootstrap page" decision —
  that stopped being true once SHEET_SCHEMA started growing tab-by-tab
  across phases (Classes, day_sections, day_plan_items), each requiring
  a re-run of Initialize Sheet; worse, with no in-app link, reaching
  `/setup` meant typing the URL into a fresh browser tab, whose empty
  `sessionStorage` meant the cached auth token never carried over — an
  actual bug this caused, not just an inconvenience, fixed by adding it
  to `Nav.tsx` and rendering `<Nav>` on `Setup.tsx` itself);
  `src/components/ui/*` are shadcn primitives.

`src/lib/{provider,rules,auth}.ts` are thin `export *` wrappers giving
UI code a stable `src/`-relative import path to the domain/data files —
those stay plain `.js` (not rewritten to `.ts`), with types added
incrementally at the call site instead, in `src/lib/types.ts`.

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
Phases 0–6 are code-complete, and the entire app is now React (Vite +
TypeScript + Tailwind + shadcn/ui) — the old static `app/*.html` pages
are gone, deleted one at a time as each got a verified equivalent, not
all at once.

Verified live against the real template Sheet: 5 of the app's 7 routes
(`/`, `/plan-tomorrow`, `/checkpoints`, `/report`, `/setup`) load and
correctly read real data with no console errors. Add Person (on `/`) is
confirmed working end-to-end (write, then read back live via redirect).
`initializeSheet` was verified live back in Phase 2 (same function,
now wired into `/setup`'s React version instead of the old inline
script).

Not yet personally clicked through in the current React UI: habit/task
checkbox writes, Plan Tomorrow's add-task/close-out, Checkpoints' create/
reward-CRUD, and Setup's Initialize Sheet button specifically —
code-complete and type-checked, with real data loading correctly beneath
them, but the write action itself hasn't been exercised end-to-end since
the port. Don't treat these as fully done until they have been.

The `/habits` route (create/rename/deactivate) and Plan Tomorrow's "Skip
tomorrow" action are brand new and entirely unverified live — code-
complete, `tsc -b` clean, and the underlying logic (provider CRUD
round-trips, `evaluateWeeklyRule`/`computeHabitCompletionRate`'s
`'skipped'`-neutral math, `getUnclosedHabits` not double-logging an
already-skipped habit) was checked with standalone mocked-`fetch`/pure-
function scripts, not against the live Sheets API or by clicking through
the actual UI (browser automation was unavailable this session). Treat
as unverified until someone has: added a habit via `/habits` and seen it
on Today/Plan Tomorrow the same day; skipped a habit in Plan Tomorrow and
confirmed it's not actionable in tomorrow's Today and isn't double-logged
`'missed'` at close-out; and confirmed a habit with skipped history isn't
penalized in the Report/weekly-rule numbers, all against a real Sheet.

Phase 10 (Classes) is likewise entirely unverified live — `/classes`
CRUD, Today's Done/Skip/Skip (teacher)/Reschedule actions, and Plan
Tomorrow's class-skip action are all code-complete and `tsc -b`
clean, with the domain math (`getExpectedClassesForDate`'s weekday
matching, `evaluateClassAttendance`'s teacher-skip-is-neutral treatment)
and provider CRUD round-trips checked the same mocked-`fetch`/pure-
function way as the habits work above — not against the live Sheets API,
and not clicked through in a real browser (browser automation stayed
unavailable this session too). Treat as unverified until someone has:
added a class via `/classes` with specific weekdays and confirmed it only
appears on Today/Plan Tomorrow on those weekdays; confirmed Skip defaults
to student with Skip (teacher) as a clearly one-extra-click alternative;
confirmed Reschedule logs the new time without also logging the original
slot as missed; and confirmed deactivating a class leaves `class_log`
history intact.

Correction to earlier entries in this section that said "`tsc --noEmit`
clean": this repo's root `tsconfig.json` is solution-style (`"files": []`,
references out to `tsconfig.app.json`/`tsconfig.node.json`) — a bare
`tsc --noEmit` against it type-checks nothing and reports no errors
regardless of what's actually wrong, silently. The real check is `tsc -b`
(what `npm run build` runs) or `tsc -p tsconfig.app.json --noEmit`. Once
caught, `tsc -b --force` was run against the full accumulated diff through
Phase 11 and passed clean, and `npm run build` (full Vite production
build) also succeeded — so nothing upstream was actually hiding a type
error, but treat any *future* session's "`tsc --noEmit` clean" claim in
this file as suspect unless it says `tsc -b` specifically.

Checkpoints' grant flow is now verified live — clicking Grant surfaced
two real bugs, both fixed: (1) `grantReward` (`keystone-provider.js`) was
re-fetching the checkpoint via raw `fetchSheetTab('checkpoints')`, whose
`itemIds`/`rewardIds` come back as raw comma-separated strings, not the
arrays `getCheckpoints()` normally parses them into via `parseList` —
calling `.join(',')` on a string threw `is not a function`; fixed by
running the same `parseList` step there. (2) `isCheckpointReady`
(`keystone-rules.js`, see Reward model above) ignored `checkpoint.status`
entirely, so `[ready to grant]` kept showing next to `granted` checkpoints
forever — fixed to return `false` once `status === 'granted'`.

Auth-persistence fix (sessionStorage rehydration on mount, see Provider
above) touched `keystone-auth.js`'s previously-stable-since-Phase-1
contract — it gained one new export, `getCachedToken()`; existing exports
(`requestSignIn`, `requestSilentToken`, `clearCachedToken`) are unchanged.
Verified live: sign in on Today, nav to Plan Tomorrow, hard refresh all
stayed signed in with no popup.

Read-request batching (see Provider above) verified with a standalone
script mocking `fetch` — 4 concurrent `provider.getX()` calls collapsed
into 1 HTTP call as intended — but not yet re-verified against the *live*
Sheets API/quota, since the 429 that motivated it was rate-based and hard
to reliably re-trigger/clear on demand. If 429s recur even after this,
suspect React `StrictMode`'s dev-only double-effect-invocation (in
`main.tsx`) as a secondary multiplier — it doesn't affect production
builds, so isn't fixed here, but is worth knowing about if local dev
testing still burns quota fast.

Phase 11 (day sections + drag-reorder) is code-complete, `tsc -b` clean,
and `npm run build` succeeds (this phase's dnd-kit usage was the reason
the `tsc --noEmit`-vs-`tsc -b` gap above got caught — a type-only-import
error `tsc -b`/the real build surfaced that a bare `tsc --noEmit` had been
silently missing). The pure grouping logic (`groupItemsBySections`'s
default-to-lowest-section and deleted-section-fallback behavior) and the
provider layer (`addPerson`/`initializeSheet` seeding+backfill,
`upsertDayPlanItem`'s insert-then-update-in-place) were both verified with
mocked-`fetch`/pure-function scripts. What's genuinely unverified: the
actual drag-and-drop interaction in a browser — `@dnd-kit`'s pointer-event/
collision-detection machinery isn't practically unit-testable outside a
real DOM, and browser automation was unavailable this entire session (not
just this phase). Treat the drag mechanics specifically — not just the
data layer — as unverified until someone has dragged an item between
sections and within a section on both Today and Plan Tomorrow, reloaded,
and confirmed the order stuck.

Phase 11's habit-fixed-section amendment (see Data model above) is also
code-complete, `tsc -b`/`npm run build` clean, and the core grouping rule
was verified two ways: a standalone script confirming a habit stays in
its `sectionId`-declared home even when a (deliberately adversarial)
`day_plan_items` row claims a different section, honoring only that row's
`itemSortOrder`; and a second script reproducing exactly how
Today.tsx/PlanTomorrow.tsx build their item list (catching a real bug in
the process — the pages wrap habits as `{itemType, itemId, habit}` with
no top-level `sectionId`, which `groupItemsBySections` reads directly, so
the fixed-home rule would have silently no-opped for every habit on both
pages; fixed by adding `sectionId: habit.sectionId` to that wrapper in
both files). Unverified live, same caveat as the rest of Phase 11: the
`DayPlanBoard` reject-cross-section-drop-for-habits behavior and the
"other sections dim while dragging a habit" visual cue haven't been
clicked through in a real browser.

`/setup` is now in `Nav.tsx` (see Architecture layers above) — `tsc -b`/
`npm run build` clean, not yet clicked through live, but low-risk: it's
an additive `<Link>` plus rendering the existing `<Nav>` component on
`Setup.tsx`, no logic changed.

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
  unlogged habits as `'missed'`). Code-complete. Extended post-hoc with a
  standalone `/habits` management page (create/rename/deactivate — the
  "habits palette" originally had no CRUD UI of its own, habits could only
  be read) and a per-habit "Skip tomorrow" action in Plan Tomorrow
  (logs `'skipped'` for tomorrow's date at plan time; see Data model and
  Weekly rule metric grammar above for the new status and its rolling-
  window treatment).
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
- **Phase 10 — Classes.** A third recurring-item type, deliberately
  modeled as its own entity rather than a Habit extension. Code-complete,
  unverified live (see Status).

  **Why not just a Habit field** — Habit fails identity/lifecycle/
  invariant tests a shared model would need to pass:
  - *Occurrence rule differs.* A Habit implicitly happens every day
    (daily-reset). A Class only happens on specific weekdays at a
    specific time (`Wed 2pm`, `Wed+Thu 3pm`). Bolting a weekday/time
    filter onto Habit would mean every place that assumes "habits can
    occur any day" (the rolling `done>=N/M` window math, Report's
    completion rate) needs conditional logic to know which days a given
    "habit" was even expected — a leaky abstraction, not a shared one.
  - *Per-occurrence override is a distinct concept.* Rescheduling one
    Wednesday's piano to Thursday doesn't change the recurring rule
    (still Wed 2pm going forward) — a one-off exception to an otherwise-
    fixed schedule. Habits have no equivalent concept.
  - *Skip attribution is Class-specific and reporting-relevant.* "Missed"
    for a Habit is just missed. For a Class, *who* skipped (student vs.
    teacher) changes what the number means — a teacher-cancelled session
    shouldn't count against attendance the way a self-skip should. A
    genuinely different invariant, not an optional extra field.

  Cramming this into Habit would mean `evaluateWeeklyRule`'s grammar and
  Report's math both branch internally on "is this actually a class" —
  worse than a parallel, purpose-built model. So: separate `classes`/
  `class_log` tabs (see Data model above), separate pure rule functions
  in `keystone-rules.js` (`getExpectedClassesForDate`,
  `evaluateClassAttendance` — additive, `evaluateWeeklyRule`'s existing
  habit grammar/behavior is untouched), separate `/classes` CRUD page
  (parallel to `/habits`).

  **Schema**: `classes` — `classId`, `personId`, `name`, `daysOfWeek`
  (comma-list of `Sun`..`Sat`, e.g. `"Wed,Thu"`), `startTime` (`HH:MM`),
  `durationMinutes`, `active` (same visibility-not-existence convention
  as `habits.active`). `class_log` (append-only) — `classId`, `personId`,
  `date`, `status` (`'done'`/`'skipped'`/`'rescheduled'`), `rescheduledTo`
  (new datetime, only set when `status === 'rescheduled'` — the original
  slot is simply superseded by this log entry, not separately tracked),
  `skippedBy` (`'student'` default / `'teacher'`, only set when
  `status === 'skipped'`).

  **Where actions live**: Today shows only classes expected *that* date
  (`getExpectedClassesForDate`), with same-day actions — Done, Skip
  (defaults `skippedBy: 'student'`; "Skip (teacher)" is a second, clearly-
  secondary button, not a form field, to keep the common case one click)
  and Reschedule (inline date/time picker, only appears once clicked).
  Plan Tomorrow shows tomorrow's expected classes with a Skip-only action
  (mirrors the Habit "Skip tomorrow" precedent from Phase 4) —
  deliberately no Done/Reschedule there, since marking a class done
  before it happens doesn't make sense and reschedule-a-day-ahead wasn't
  a stated need; both stay Today-only actions.
- **Phase 11 — Day sections + drag-reorder.** Groundwork for a later full
  calendar/specific-time view (separate future phase, not built here) —
  this phase is just the section/ordering data model and a list UI, not a
  calendar grid. Code-complete, unverified live (see Status). Fulfills the
  "Checkpoint time-binding mode" backlog idea (see Future scope below) for
  habits/tasks/classes at the loose/section-grouping level; specific-
  time/calendar-grid binding is still future scope, not done by this
  phase. Amended before any calendar-view phase began: Habits have a
  *fixed* home section (a `habits.sectionId` column), while Tasks/Classes
  keep freely-reassignable-per-day placement — see the "Habits vs.
  Tasks/Classes are deliberately asymmetric" paragraph in Data model
  above for the full rule and why it's intentional, not an inconsistency.

  **Data model**: `day_sections` (`sectionId`, `personId`, `name`,
  `sortOrder`) — per-person config, seeded with 3 defaults (Morning/
  Afternoon/Evening) on `addPerson` and backfilled for pre-existing people
  by `initializeSheet`; nothing beyond the seed data hardcodes "3," the
  user can add/rename/reorder/delete freely. `day_plan_items` (`personId`,
  `date`, `itemType`, `itemId`, `sectionId`, `itemSortOrder`) — one day's
  placement of a habit/task/class instance, separate from the definition
  tabs and NOT append-only (upserted in place as the user drags, unlike
  `habit_log`/`class_log`).

  **Domain logic**: `groupItemsBySections` (`keystone-rules.js`) is pure —
  groups a day's items into their assigned sections, sorted within each.
  An item with no `day_plan_items` row yet (new, or a date nobody's
  arranged) defaults to the lowest-`sortOrder` section rather than
  erroring. An item whose stored `sectionId` no longer matches any current
  section (its section was deleted) gets the same fallback — this is why
  `deleteDaySection` doesn't need to cascade-update `day_plan_items` at
  all: orphaned items self-heal on next read instead of vanishing.

  **UI**: `src/components/DayPlanBoard.tsx` is a shared drag-and-drop
  component (`@dnd-kit/core` + `@dnd-kit/sortable` — chosen over a
  calendar/grid library since this phase is explicitly list-based, not a
  calendar view yet) used by both Today (same-day adjustments — the
  motivating real-life case was "she may do breakfast before singing," so
  same-day reordering matters, not just next-day planning) and Plan
  Tomorrow (the primary place arrangement happens). It owns drag mechanics
  and grouping display only — each page supplies its own per-item-type row
  rendering (habit checkbox, task checkbox, class Done/Skip/Reschedule)
  via a `renderItem` render-prop, so `DayPlanBoard` itself has no
  business logic of its own, matching the UI-layer convention. On drop, it
  computes a *fractional* sort key (midpoint of the two neighboring
  items' `itemSortOrder`, or ±1 past whichever end it's not) rather than
  renumbering every sibling in the section — one `upsertDayPlanItem` write
  per drag, not one per item, deliberately, given Sheets API write quota
  is a real constraint (see the read-quota 429 story in Provider above).
  Plan Tomorrow additionally gets a small inline section-management UI
  (add/rename/reorder/delete) at its top, rather than a separate settings
  page — that's the natural point of use. Classes remain draggable into
  sections for visual grouping even though their `startTime` is fixed and
  doesn't change — the person is planning around them as anchors, per the
  original ask.

**Out of scope for the entire roadmap**: public/verified OAuth (Testing
mode + Test Users list only), notifications/reminders, a native/mobile
wrapper (web only).

## Future scope / backlog
Ideas that exist but haven't been shaped into a roadmap phase yet —
nothing in this section is "next up" the way roadmap phases are.

- **Checkpoint time-binding mode**: **partially fulfilled by Phase 11**
  (day sections + drag-reorder) at the "loose" end — items now belong to
  a named section (Morning/Afternoon/Evening/custom) and have an order
  within it, which is the loose/sometime-before-a-deadline half of this
  idea. Still open: the "pinned" half (a specific clock time, not just a
  section) and the per-day/per-context flex (school day vs. holiday,
  workday vs. off day changing which mode applies) — that's the "later
  full calendar/specific-time view" Phase 11 explicitly deferred, not
  something to bolt onto day_sections. Needs its own roadmap phase when
  scoped.
