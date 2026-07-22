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
(via `/habits`) hides it from Today/Plan without touching its
`habit_log` history, since that history is append-only and a hard delete
would orphan past rows' `habitId` reference. `habit_log.status` has three
values now: `'done'`, `'missed'` (both existing), and `'skipped'` — set at
*plan* time from `/plan` (not close-out time) when a habit
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

**Points system (Phase 12)** — flat per-item points, alongside (not
replacing) the checkpoint/parent-granted reward model below. `habits`,
`tasks`, and `classes` each gained a `pointValue` column (numeric,
default 1). Three new tabs: `points_log` (append-only — `personId`,
`date`, `itemType`, `itemId`, `pointsEarned`; one row per completion,
snapshotting `pointValue` at that moment), `points_rewards` (`rewardId`,
`name`, `pointCost` — **no `personId`**, deliberately a shared family
catalog, unlike `reward_catalog` which is per-person), and
`points_redemption_log` (append-only — `personId`, `rewardId`, `date`,
`pointsSpent`). See Phase 12 in the Roadmap for the full ledger-vs-
mutable-balance reasoning, the check/uncheck-reversal rule, and what's
explicitly deferred (combo/compound weekly rules).

**Milestone auto-rewards (Phase 13)** — a second, distinct reward
mechanic layered on top of the points ledger. Two new tabs:
`points_milestones` (`milestoneId`, `personId`, `pointInterval`,
`rewardDescription` — per-person config, e.g. "every 100 points, comic
book") and `milestone_grants_log` (append-only — `personId`,
`milestoneId`, `date`, `pointsBalanceAtGrant`). **Auto-granted, no
parent confirmation** — an explicit, intentional exception to the
parent-granted convention checkpoints and points-catalog redemption both
follow (see Reward model below); don't "fix" this into a grant-approval
step later, it's deliberate. See Phase 13 in the Roadmap for the
redeem-safety mechanics (why grants are based on cumulative earned
points, never current balance).

## Reward model
Checkpoints group items and carry a reward (fixed or open/pick-from-pool).
Rewards are parent-GRANTED, never automatic — a checkpoint hitting 100%
just surfaces "ready," a human decides when to grant it (including
partial-completion judgment calls). Points-catalog redemption (Phase 12)
follows the same parent-facing spirit in practice, even though there's no
literal "grant" step — a parent/kid taps Redeem together, it's still a
human-initiated action, not something that fires on its own.

**Milestone auto-rewards (Phase 13) are the one deliberate exception to
"parent-granted."** They fire automatically the instant cumulative earned
points cross the configured interval — no tap, no "ready, awaiting
grant" state, no human in the loop at all. This is intentional, not an
inconsistency to fix later: milestones are meant to feel like an
automatic bonus/streak reward (think: a game's level-up), distinct in
kind from checkpoints' and points-redemption's parent-mediated rewards.
If you're reading this wondering why milestones don't go through a grant
step like everything else here — that's why.

`isCheckpointReady` (in
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
used with status `'skipped'` from `/plan` at plan time, not just
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
`deleteReward` are basic CRUD against `reward_catalog` (managed from
Checkpoints' "Reward catalog" card — this already existed, not new);
`grantReward` appends a `reward_log` row and flips the matching
checkpoint's status to `granted`; `getHabitLogRange(personId, from, to)`
backs the report page's multi-day read (still just filtering by
caller-given range, not deciding what the range should be — that
judgment stays in `src/pages/Report.tsx`). `addWeeklyRule(personId,
metric, rewardId)`/`updateWeeklyRule(ruleId, metric, rewardId)`/
`deleteWeeklyRule(ruleId)` are `weekly_rules` CRUD, managed from
`/report` — see Weekly rule metric grammar below for the string-building
convention and the `ruleId` column this added.
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

`awardPoints(personId, dateISO, itemType, itemId, pointsEarned)` appends
to `points_log` (append-only) — called internally by `setHabitStatus`/
`setTaskStatus`/`logClassStatus` whenever `pointsDeltaForTransition`
(`keystone-rules.js`) computes a nonzero delta for that status change,
never by UI code directly. This is the first (Phase 12) actual use of
the provider -> rules dependency direction the architecture doc always
allowed but this file never previously imported — `keystone-provider.js`
now imports `pointsDeltaForTransition`/`computePointsBalance` from
`./keystone-rules.js`, since "how many points is this transition worth"
and "how is a balance derived" are decisions, not data-fetching, and
belong there. `setHabitStatus` gained a 4th param, `previousStatus`
(caller already has it, from the same local state `isValidStatusTransition`
already checks — no extra fetch needed); `setTaskStatus` needed no
signature change, since it already reads the existing row, hence the
prior status, before overwriting it; `logClassStatus` needs neither —
a class's status is one-way (no toggle-back once logged for a date), so
points are only ever awarded there, never reversed.
`addPointsReward`/`updatePointsReward`/`deletePointsReward` are
`points_rewards` CRUD (shared catalog, no personId — see Data model);
`getPointsBalance(personId)` fetches `points_log`+`points_redemption_log`
(batched into one request, same mechanism as any other same-tick
`Promise.all`) and derives the balance via `computePointsBalance` —
never stores it. `redeemPointsReward(personId, rewardId, dateISO)`
re-derives the balance and rejects (throws) if it's short of the
reward's `pointCost`, before appending to `points_redemption_log`.

`awardPoints` (above) now also runs `checkAndGrantMilestones` as a
follow-up step after every points_log append — including reversal calls
(negative `pointsEarned`), which is safe/harmless there since a
reversal can only ever reduce how many levels are achievable, never
cause a false grant. Cheap no-op for a person with zero configured
milestones (only `points_milestones` gets read before bailing out).
`addPointsMilestone`/`updatePointsMilestone`/`deletePointsMilestone`/
`getPointsMilestones` are `points_milestones` CRUD, same pattern as
elsewhere; `getMilestoneGrantsLog(personId)` is read-only — grant rows
are only ever written by `checkAndGrantMilestones`, never directly by a
caller. `calculateAchievementRate(logs, itemDefs, itemType, personId,
periodStart, periodEnd)` (`keystone-rules.js`) is the Phase 13
achievement-percentage function — pure, generalizes
`computeHabitCompletionRate`/`evaluateClassAttendance` to an arbitrary
date range and to Tasks; both of those older functions still exist
(harmless, still exported) but `/report`'s UI now calls this newer one
instead — see Phase 13 in the Roadmap for the per-item-type denominator
rules and why Tasks needed a different convention (no per-day log to
work from).
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
signed in, though: each page (`Today`/`Plan`/`Checkpoints`/`Setup`)
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
grammar (parsed in `src/shared/keystone-rules.js`'s `evaluateWeeklyRule`,
via `parseWeeklyMetric`): `"<habitId>:done>=<N>/<M>"`, e.g.
`"h3:done>=5/7"` — habitId must have >= N `'done'` `habit_log` rows
within a **rolling** M-day window ending on the evaluation date (not
calendar Mon–Sun, so evaluation never jumps discontinuously at a week
boundary). Report habit-completion-rate math uses the same
rolling-window convention.

`/report` now has full CRUD for `weekly_rules` (closes the gap this
section used to flag — Phase 6 originally shipped evaluation only, no
UI, rows had to be added by hand in the Sheet). The UI never lets the
user type or edit the raw grammar string: `parseWeeklyMetric`/
`buildWeeklyMetric` (both exported from `keystone-rules.js`) convert
between the string and `{habitId, threshold, windowDays}`, so the add/
edit form is a habit dropdown (that person's active habits) plus two
number inputs — the string gets composed, never hand-typed, so it can't
be malformed. N ≤ M is validated client-side before the Add/Save button
enables (a rule requiring more done-days than the window has doesn't
mean anything). `weekly_rules` gained a `ruleId` column (`addWeeklyRule`/
`updateWeeklyRule`/`deleteWeeklyRule` in `keystone-provider.js`, same
generate-id/re-fetch-existing-row CRUD pattern as everywhere else) since
it previously had no dedicated identity column, which update/delete both
need. `rewardId` on a rule is optional and just links to an existing
`reward_catalog` entry for the parent's reference — nothing auto-grants
it; granting still only ever happens through the Checkpoints grant flow
(see Reward model above).

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
(`/`, `/plan`, `/checkpoints`, `/report`, `/setup`) load and
correctly read real data with no console errors. Add Person (on `/`) is
confirmed working end-to-end (write, then read back live via redirect).
`initializeSheet` was verified live back in Phase 2 (same function,
now wired into `/setup`'s React version instead of the old inline
script).

Not yet personally clicked through in the current React UI: habit/task
checkbox writes, Plan's add-task/close-out, Checkpoints' create/
reward-CRUD, and Setup's Initialize Sheet button specifically —
code-complete and type-checked, with real data loading correctly beneath
them, but the write action itself hasn't been exercised end-to-end since
the port. Don't treat these as fully done until they have been.

The `/habits` route (create/rename/deactivate) and Plan's "Skip
tomorrow" action are brand new and entirely unverified live — code-
complete, `tsc -b` clean, and the underlying logic (provider CRUD
round-trips, `evaluateWeeklyRule`/`computeHabitCompletionRate`'s
`'skipped'`-neutral math, `getUnclosedHabits` not double-logging an
already-skipped habit) was checked with standalone mocked-`fetch`/pure-
function scripts, not against the live Sheets API or by clicking through
the actual UI (browser automation was unavailable this session). Treat
as unverified until someone has: added a habit via `/habits` and seen it
on Today/Plan the same day; skipped a habit in Plan and
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
appears on Today/Plan on those weekdays; confirmed Skip defaults
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
Verified live: sign in on Today, nav to Plan (then still named "Plan
Tomorrow" — see Phase 14 for the later rename/generalization), hard
refresh all stayed signed in with no popup.

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
sections and within a section on both Today and Plan, reloaded,
and confirmed the order stuck.

Phase 11's habit-fixed-section amendment (see Data model above) is also
code-complete, `tsc -b`/`npm run build` clean, and the core grouping rule
was verified two ways: a standalone script confirming a habit stays in
its `sectionId`-declared home even when a (deliberately adversarial)
`day_plan_items` row claims a different section, honoring only that row's
`itemSortOrder`; and a second script reproducing exactly how
Today.tsx/PlanTomorrow.tsx (renamed `Plan.tsx` in Phase 14, see below —
this note describes the bug as found at the time, under the old name)
build their item list (catching a real bug in
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

`weekly_rules` CRUD on `/report` (see Weekly rule metric grammar above)
is code-complete, `tsc -b`/`npm run build` clean, and verified two ways:
a script confirming `buildWeeklyMetric`/`parseWeeklyMetric` round-trip
correctly and that the client-side N ≤ M check rejects an invalid pair;
and a second script reproducing the actual page flow end-to-end —
build a metric from form-shaped inputs, `addWeeklyRule`, reload via
`getWeeklyRules`, evaluate the reloaded row with the real
`evaluateWeeklyRule` and confirm the result matches what was entered.
Not yet clicked through live in a browser, same caveat as everything
else this session. While scoping this, confirmed `reward_catalog` CRUD
already has a UI — Checkpoints' "Reward catalog" card (add/edit/delete)
predates this session and was already wired end-to-end — so nothing new
was needed there; the CLAUDE.md gap this closes was specifically about
`weekly_rules`, not rewards.

Phase 12 (Points system) is code-complete, `tsc -b`/`npm run build`
clean. Before implementing, one real design gap in the original ask got
resolved by asking: whether unchecking a habit/task after points were
awarded should reverse them — resolved as yes (see Phase 12's "check/
uncheck-reversal rule" in the Roadmap), since otherwise repeated
toggling would farm points indefinitely with no other way to "undo" an
append-only ledger entry. Verified with two mocked-`fetch` scripts: the
pure functions (`pointsDeltaForTransition`, `computePointsBalance`)
against hand-computed expected deltas/balances for every transition
case; and a full provider-level integration script reproducing the
actual sequence an app session would produce — check a habit (+points),
uncheck it (exact reversal back to 0), recheck (+points again),
complete a class (+points), skip a class (no points), attempt to redeem
with insufficient balance (rejected, balance unchanged), earn enough and
redeem successfully (balance decreases exactly by `pointCost`, a
`points_redemption_log` row appears) — every assertion passed, including
inspecting the raw `points_log` rows to confirm each one shows the
`pointValue` that was actually in effect at that moment. What's
unverified: the live UI — balance display on Today, the redeem button's
enabled/disabled state, the `pointValue` inputs on `/habits`/`/classes`/
Plan's add-task form — none of it has been clicked through in
a real browser, same standing caveat as every other phase this session.

Phase 13 (milestones + achievement report) is code-complete, `tsc -b`/
`npm run build` clean. Milestone logic verified with a mocked-`fetch`
integration script that runs the exact scenarios the phase was scoped
to validate: two completions crossing one 100-point milestone (exactly 1
grant, not per-completion); redeeming the full balance down to 0 then
re-earning back up to the original balance (confirmed **no** re-grant —
the specific bug the redeem-safety design exists to prevent); earning
further to cross a second interval (exactly 1 more grant, 2 total). The
achievement-rate function was verified directly against hand-computed
expected values for each item type, including the habit-skip-neutral
and class-teacher-skip-neutral denominator cases. Unverified: the actual
UI — period selector recompute, milestone CRUD on Checkpoints, the
"N milestones earned" count on Today — none of it clicked through live,
Chrome automation still couldn't reach this project's dev server from
this environment when last attempted (see the session's earlier
diagnosis: the automated browser and this shell aren't on the same
network namespace, external sites load fine, only localhost/127.0.0.1
fails) — try again if the environment changes, but don't assume a retry
alone will fix it.

Phase 14 (Plan generalization) is code-complete, `tsc -b`/`npm run
build` clean. Verified: the date-label logic (`targetDateLabel`/
`addDaysISO`, including a month-rollover case) and the `?date=`
validation regex, both via a standalone script since they're plain date
arithmetic with no I/O — not against the actual React component (can't
easily execute a `.tsx` component's logic outside a browser runtime).
Grepped the whole diff for stray `plan-tomorrow`/`PlanTomorrow`
references post-rename and fixed everything found outside of
deliberately-historical narrative in this file. Unverified, same
browser-access blocker as everything else: the actual page in a
browser — Nav's "Plan Tomorrow" link still landing correctly on
tomorrow by default, Today's new "Adjust today's plan" link correctly
targeting today, drag/skip/close-out all behaving identically to before
regardless of which date is loaded, and specifically the close-out-day
card's visibility toggling correctly between the two cases.

The date-picker addition (same phase) is also code-complete, `tsc -b`/
`npm run build` clean — flagged by the user immediately after the first
pass landed, since hand-editing a URL query param isn't a real UI.
Unverified live, same blocker: whether picking a date in the `<input
type="date">` or clicking Today/Tomorrow actually triggers the
same-path re-render + `useEffect` refetch as designed, rather than some
subtlety in how `useNavigate()` interacts with a component that's
already mounted — this is exactly the code path the "component-level
correctness note" above was written defensively for, but "written
defensively for" and "confirmed correct against a real click" are
different things.

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
  window treatment). Phase title kept as-is for history — the page itself
  was later renamed/generalized to `Plan` (any date, not just tomorrow),
  see Phase 14.
- **Phase 5 — Checkpoints + reward catalog + grant flow.** Group habits/
  tasks into a checkpoint with a reward (fixed or open/pool); reward
  catalog CRUD; grant action available at any completion %. Code-complete.
- **Phase 6 — Weekly rules + reports.** `evaluateWeeklyRule` (see grammar
  above); week report — habit completion %, task aging, reward history —
  computed client-side, no new tabs/columns. Code-complete. Extended
  post-hoc with full `weekly_rules` CRUD on `/report` (the phase
  originally shipped evaluation only, rows had to be added by hand in
  the Sheet — see Weekly rule metric grammar above for how the gap
  closed and why it's safe: the grammar string is always composed from
  a habit picker + two numbers, never hand-typed).
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
  Plan shows the target date's expected classes with a Skip-only action
  (mirrors the Habit "Skip [date]" precedent from Phase 4) —
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
  Plan additionally gets a small inline section-management UI
  (add/rename/reorder/delete) at its top, rather than a separate settings
  page — that's the natural point of use. Classes remain draggable into
  sections for visual grouping even though their `startTime` is fixed and
  doesn't change — the person is planning around them as anchors, per the
  original ask.
- **Phase 12 — Points system.** Flat per-item points, alongside — not
  replacing — the checkpoint/parent-granted reward model (Phase 5).
  Built before the calendar-view phase, same "land the foundation before
  building on it" ordering as Phase 11's amendment. Code-complete,
  unverified live (see Status).

  **Why an append-only ledger, not a live calculation**: point values
  are configurable per item (`pointValue` on `habits`/`tasks`/`classes`),
  which means they'll change over time as values get tuned. If points
  were computed on the fly (`pointValue × completions`, read at balance-
  check time), editing an item's `pointValue` later would retroactively
  change everyone's *historical* earned points — silently rewriting the
  past. Instead, earning an item snapshots its `pointValue` *at that
  moment* into `points_log` — the same append-only principle `habit_log`/
  `class_log` already follow. **Do not "optimize" this into a stored,
  mutable balance counter later** — a stored counter can drift out of
  sync with its own ledger (a missed decrement, a race, a bug); deriving
  the balance fresh from the full log on every read cannot. This was a
  deliberate, explicit design decision, not an oversight to fix.

  **The check/uncheck-reversal rule**: Habits and Tasks are two-way
  (a checkbox, done ↔ missed/pending); Classes are one-way (Done/Skip/
  Reschedule, no toggle-back once logged for a date). Without a rule for
  what happens when a habit/task is unchecked after earning points,
  repeated checking/unchecking would farm points indefinitely — there's
  no other way to "undo" an append-only `points_log` entry. The resolved
  rule (`pointsDeltaForTransition` in `keystone-rules.js`): entering
  `'done'` earns the item's current `pointValue`; **leaving** `'done'`
  appends a *negative* `points_log` entry for exactly that amount (a
  reversal row, never an edit of the original — ledger stays append-
  only); any other transition is a no-op. Net effect of check → uncheck →
  recheck is exactly one item's worth of points, not three. Classes don't
  need the reversal half of this rule at all, by construction (no
  toggle-back), so `logClassStatus` only ever awards, never reverses.

  **Combo/compound weekly rules are explicitly OUT OF SCOPE for this
  phase** — e.g. "habit X done ≥5/7 AND class Y attended AND task Z done"
  earning a bonus. This phase only does flat per-item earning and
  redemption. Compound-rule evaluation is a follow-up phase once basic
  points have been validated in daily use — don't build it prematurely;
  see `keystone-rules.js`'s Phase 12 comment block for the same note
  in-code, so it doesn't get built accidentally while touching nearby
  code.

  **Data model / provider / domain**: see Data model and Provider above.

  **UI**: Today shows the balance as a small, non-intrusive line next to
  the date/person status text (not a card — this is a supplementary
  system, shouldn't visually compete with the main habit/task/class
  list), refreshed after any action that might earn/reverse points.
  Checkpoints gained a "Points" card (alongside, not replacing, its
  existing "Reward catalog" card) for the points-rewards catalog CRUD, a
  Redeem button per reward (disabled — not hidden — when balance is
  short, with a tooltip saying how many more points are needed) and a
  redemption history list. `/habits`, `/classes`, and Plan's
  add-task form each gained a `pointValue` number input (default 1).
- **Phase 13 — Milestone auto-rewards + achievement percentage report.**
  Two unrelated mechanics bundled into one phase. Code-complete,
  unverified live (see Status).

  **A. Milestone auto-rewards** — a second, distinct reward mechanic on
  top of the Phase 12 points ledger; see Reward model above for why it's
  the one deliberate exception to "parent-granted." Fires the instant
  cumulative *earned* points (not current balance) cross a configured
  `pointInterval`. The redeem-safety mechanic: "how many levels have
  already fired" is tracked by counting existing `milestone_grants_log`
  rows for that milestone, never by re-deriving a level from
  balance ÷ interval on the fly — the latter would let a redeem-then-
  re-earn-to-the-same-balance cycle look like a fresh crossing and
  falsely re-fire. Basing the crossing check on lifetime *earned* points
  instead of *balance* is what makes spending safe: redemption only
  touches `spent`/`balance`, never `earned`, so it can never cause a
  milestone to un-cross. `computeMilestoneGrantsDue(totalEarned,
  pointInterval, existingGrantCount)` is the pure decision
  (`keystone-rules.js`); `checkAndGrantMilestones`
  (`keystone-provider.js`) is the I/O wrapper, invoked automatically
  inside `awardPoints`.

  **B. Achievement percentage report** — generalizes the existing
  rolling-window completion math to (a) an arbitrary period, not just a
  fixed lookback, (b) percentage output per item, not pass/fail, (c) all
  three item types (habits/tasks/classes), not just habits.
  `calculateAchievementRate` (`keystone-rules.js`) takes an explicit
  `[periodStart, periodEnd]` — same "caller computes the range, this
  function doesn't decide it" convention as `getHabitLogRange` — and
  returns one result per item, never a blended average (Report renders
  "piano: 90%, English: 100%" individually). Denominator conventions:
  Habits — days in range minus `'skipped'` days (same neutral treatment
  as `computeHabitCompletionRate`). Classes — expected occurrences per
  `daysOfWeek` in range, minus `skippedBy:'teacher'` rows (neutral,
  same convention as `evaluateClassAttendance`); `skippedBy:'student'`
  rows count against it, same as always. Tasks — no existing per-period
  completion convention to match (a task's status is a single mutable
  field, not a recurring daily log entry, so `habit_log`/`class_log`'s
  rolling-window shape doesn't apply); "in range" means `createdDate`
  falls in the period, rate is binary per task (done ÷ 1). `/report`'s
  period selector (Week/Month/Year) uses the same rolling-day-count
  convention as everywhere else in this codebase (not calendar month/
  year boundaries) — 7/30/365 days ending today. `habit_log`/`class_log`
  are fetched once for the widest period (365 days) up front; switching
  the selector is a client-side recompute over already-loaded rows, not
  a re-fetch — deliberate, given this project's read-quota history (see
  Provider above). The old fixed-7-day "Habit completion" card and its
  backing function (`computeHabitCompletionRate`) are superseded by this
  but not deleted — still exported, still correct, just no longer
  wired into any page; same for `evaluateClassAttendance`, which had
  never been wired into a page at all before this. **Combo-checkpoint UI
  (e.g. "90% piano AND 100% English") was explicitly left out this
  pass** — the prompt scoping this phase called it optional/additive and
  said to keep the per-item report as the core deliverable; needs its
  own pass if picked up later, reusing `calculateAchievementRate`
  per-item underneath.
- **Phase 14 — Generalize Plan Tomorrow into date-parametrized Plan.**
  No data-model change (route/UI generalization only). Code-complete,
  unverified live (see Status).

  **What changed**: `PlanTomorrow.tsx` renamed to `Plan.tsx`; route
  changed from the fixed `/plan-tomorrow` to `/plan?date=YYYY-MM-DD`,
  defaulting to tomorrow when no `date` is given (so the existing Nav
  "Plan Tomorrow" link needed no change beyond its `to` path — it stays
  a bare `/plan`, no date param, and keeps landing on tomorrow exactly
  as before). Every date-dependent piece that used to hardcode `tomorrow`
  (habit/class skip actions, `day_plan_items` reads/writes, expected-
  classes lookup, section arrangement) now derives from the parsed
  `?date=` param instead — audited and confirmed nothing else assumed
  "always the next day." Text that used to hardcode "tomorrow" (page
  title, "Skip tomorrow" buttons, card subtitles, the loaded-status
  line) now derives from a small `targetDateLabel` helper that reads
  "Today"/"Tomorrow" for those two specific dates and falls back to the
  raw ISO date otherwise — so the page still literally says "Plan
  Tomorrow" when viewing tomorrow (the default), unchanged from before,
  but says "Plan Today" when viewing today, etc.

  **Today.tsx is unchanged apart from one addition**: a new "Adjust
  today's plan" link (next to the status line) to `/plan?date=<today>`,
  giving arrange/reorder/section-assignment access for the current day
  without altering Today's own checkbox-list UI or behavior at all —
  that was an explicit constraint from the original ask, not just an
  implementation choice.

  **Close-out-day gating** — the one genuine judgment call in this
  phase, resolved directly by the request rather than left ambiguous:
  "Close out today" always closes out literal `today` (unchanged
  behavior, never the date being planned), but is now only *shown* when
  `targetDate !== today` — i.e. only while planning a future day.
  Showing it while `targetDate === today` would mean showing "close out
  the very day you're currently mid-way through arranging," which is
  exactly the premature-finalization risk that generalizing this page to
  same-day use (via "Adjust today's plan") introduced; hiding it in that
  one case removes the risk without changing what the button does the
  rest of the time.

  **Component-level correctness note**: `targetDate` is read from
  `window.location.search` on every render, not once at module scope
  like the old fixed `tomorrow` constant — and the main data-loading
  `useEffect` depends on `[targetDate]`, not `[]`. Originally added
  because neither of Plan's entry points at the time (Nav's bare `/plan`
  link, Today's `/plan?date=` link) actually triggered a same-path
  different-query navigation — both come from a different route, so the
  component always fully remounts — but it was implemented reactively
  anyway to close that latent gap pre-emptively. That judgment call paid
  off immediately: the date picker added right after this (below) is
  exactly that same-path-different-query case, and works because this
  was already in place.

  **Date picker (added right after this phase's first pass, same phase
  number)**: the original ask only specified the two named entry points
  (Nav's fixed "tomorrow" link, Today's fixed "today" link) — there was
  no way to reach any *other* date except by hand-editing the URL's
  `?date=` param, which isn't a real UI. Added a `type="date"` input plus
  "Today"/"Tomorrow" quick-select buttons to Plan's header; all three call
  a `goToDate(dateISO)` helper that navigates to `/plan?date=...`
  (preserving `?personId=` if present) via `useNavigate()` — a client-side,
  same-path navigation, which is precisely the case the reactive
  `useEffect` above was already built to handle correctly.

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
- **Combo/compound weekly rules for bonus points**: e.g. "habit X done
  ≥5/7 AND class Y attended AND task Z done this week" earning a bonus
  on top of the flat per-item points Phase 12 built. Deliberately not
  built as part of Phase 12 — that phase is flat per-item earning/
  redemption only; compound-condition evaluation is real new domain
  logic (a rule engine, essentially), not a small addition, and should
  wait until flat points have been validated in daily use. Needs its own
  roadmap phase when scoped — distinct from Phase 12, don't conflate.
