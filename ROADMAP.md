# Keystone Roadmap

### Phase 0 — Manual setup (done/in progress, not CC)
- Repo created, Pages enabled, cloned
- Sheets API enabled on `nyra-bhajans` Cloud project, `.../auth/spreadsheets` scope added
- Template Sheet to be created with empty tabs (Phase 1 schema) for bring-your-own-sheet users
- Test Users list includes household members as they come online

### Phase 1 — Provider abstraction + Sheet schema (foundation, no UI)
- `shared/keystone-provider.js`: function signatures + mock data — `getHabits`, `getTasks`, `getHabitLog(date)`, `setHabitStatus(date, habitId, status)`, `setTaskStatus`, `getCheckpoints(date)`, `getSheetId()` (URL param `?sheetId=`, falls back to family default, localStorage cache)
- Sheet tab schema documented: `habits`, `tasks`, `habit_log`, `checkpoints`, `reward_catalog`, `weekly_rules`, `reward_log` — exact columns per tab
- Schema also includes a `people` tab: `personId, name, theme, avatar`
- Mock data only, no live Sheets calls yet
- Out of scope: auth flow, real reads/writes, any UI

#### Sheet tab schema (column headers, literal — becomes the template Sheet header row)
This mirrors `SHEET_SCHEMA` in `shared/keystone-provider.js` for
readability — that constant is the authoritative source, read by
`initializeSheet()` to create/verify tabs. If this doc and the code ever
disagree, the code wins.
- `people`: `personId, name, theme, avatar`
- `habits`: `habitId, personId, label, active`
- `tasks`: `taskId, personId, label, createdDate, dueDate, status, lastCarriedDate`
- `habit_log`: `date, personId, habitId, status, checkpointId`
- `checkpoints`: `date, personId, checkpointId, label, itemIds, rewardMode, rewardIds, status`
- `reward_catalog`: `rewardId, personId, title, tags`
- `weekly_rules`: `personId, metric, rewardId`
- `reward_log`: `date, personId, checkpointIdOrWeekId, rewardChosen, grantedBy, status`

`habit_log` is append-only — past rows are never edited or deleted; a missed
day just stays logged as missed. `tasks` rows persist and mutate in place
until done — this is the carry-forward mechanism, there is no copying of
rows from day to day.

### Phase 2 — App-driven Sheet init + real read wiring — ✅ Complete
- `app/setup.html`: OAuth sign-in (Google Identity Services token client,
  `.../auth/spreadsheets` scope, token kept in memory only) + "Initialize
  Sheet" action — creates/verifies the 8 `SHEET_SCHEMA` tabs and removes
  an empty leftover default tab. Idempotent. No manual tab creation in
  Google Sheets, ever — the app always owns the sheet structure.
- Wire provider reads to real `values.get` calls via API key (anon, no
  OAuth needed for reads)
- Simple "Today" screen, read-only, includes checkpoints (annotated with
  `isCheckpointReady`) alongside habits/tasks
- Out of scope: full write interactivity (check off habits/tasks, grant
  rewards) — still Phase 3

**Verified** (real environment, not mocks): OAuth sign-in works end to
end through `app/setup.html`. `initializeSheet()` ran against the live
template Sheet and created all 8 `SHEET_SCHEMA` tabs with correct names,
removed the leftover default `Sheet1`, and is idempotent by design
(re-run only adds what's missing). Anonymous reads via API key work
against the real Sheet. `today.html` correctly handles both the
tabs-missing state (surfaces the Sheets API error rather than failing
silently) and the tabs-exist-but-empty state ("No people found in the
configured Sheet."). See README.md's "Common setup gotchas" for the
real issues hit along the way.

### Phase 3 — OAuth write + Today interactivity — code-complete, live verification outstanding
- OAuth sign-in (reuse existing client/scopes): silent-refresh-first via
  `shared/keystone-auth.js` (cached in `sessionStorage`), visible
  "Sign in" button fallback only if silent auth fails
- Check off habits/tasks on `today.html`, writes to `habit_log`
  (append-only) / `tasks` (mutate in place) via `setHabitStatus`/
  `setTaskStatus`, optimistic UI with rollback + inline error on failure
- Write UI hidden from anon users (`body.anon` pattern, same as Bhajans)
- **Add Person, pulled forward from Phase 8** (documented exception —
  everything else in Phase 8's profile/theming scope, incl. avatars and
  any edit/delete of people, is still Phase 8): minimal inline form on
  `today.html`, shown in place of the old dead-end "no people found"
  message once signed in. Name + theme picker (Playful/Minimal/Warm)
  only, no avatar. `personId` is client-generated (slugified name + short
  random suffix). `addPerson()` in the provider appends a row to
  `people` via the same OAuth write plumbing as the other Phase 3 writes.
- Out of scope: Plan Tomorrow, checkpoints, rewards, weekly rules,
  carry-forward logic, editing/deleting people, avatars

**Audit note:** a Phase 3 audit found live writes (`setHabitStatus`/
`setTaskStatus` against real `values.append`/`values.update`), the
silent-refresh OAuth flow, and `body.anon` write gating already fully
built and consistent with their documented contracts — only Add Person
was actually missing, and that's what this pass built. Signatures were
confirmed unchanged from the Phase 1 mock contract.

**Partially verified** (live browser test against the real template
Sheet, not mocks): Add Person confirmed working end to end — signing in
on `today.html` required allowing a browser-blocked popup first (not a
code bug, just a local dev annoyance, no fix needed), after which adding
a person redirected to `?personId=<new-id>` and correctly loaded that
person's (empty) Today view, meaning the write to `people` landed and
was read back live. As expected per scope, the Add Person form then
stayed hidden once a person exists — it's a first-person-only bootstrap,
not general people management (that's Phase 8).

**Still not verified**: a habit/task checkbox actually persisting to
`habit_log`/`tasks`, and silent-refresh actually skipping the visible
prompt on a repeat visit (both need a person with at least one habit/task
in the Sheet to test against — Plan Tomorrow / habit creation UI is
Phase 4, so today that row would need to be added by hand for testing
purposes only, not as a new "manual Sheet edit" pattern). Not marking
this phase ✅ Complete until those are confirmed too.

### Phase 4 — Plan Tomorrow + habit/task lifecycle rules
- Plan Tomorrow screen: recurring habits palette + auto-populated open tasks + one-off add
- Missed habit = logged missed, not carried; unfinished task = carries forward
- Out of scope: checkpoints/rewards, weekly rules, reports

### Phase 5 — Checkpoints + reward catalog + grant flow
- Group items into checkpoints, attach reward (fixed or open/pool mode)
- Reward catalog CRUD per person
- Parent-initiated "Grant" action at any completion % — writes `reward_log`
- Out of scope: weekly rules, reports

### Phase 6 — Weekly rules + reports
- `weekly_rules` evaluation (e.g. "read >= 5/7 days")
- Week/Month report: habit completion %, task aging, reward history — computed client-side
- Out of scope: bring-your-own-sheet polish

### Phase 7 — Bring-your-own-sheet + polish
- `?sheetId=` paste-URL flow, validation, friendly errors
- Publish template Sheet link in-app
- Final `CLAUDE.md` architecture pass

### Phase 8 — Profiles + theming
- Profile creation flow: name, avatar, theme picker
- Theme presets are feel-based, not strictly demographic-locked (e.g. "Playful," "Minimal," "Warm") — each person picks whichever fits them, not a forced kid/adult split
- Theme implemented as CSS custom properties (color palette, icon style/playfulness) swapped based on active profile — not separate stylesheets or separate builds
- New `people` Sheet tab: `personId, name, theme, avatar`
- Out of scope: per-profile layout changes beyond theme variables (e.g. different nav structure per person) — visual theme only

### Phase 9 — Family calendar view
- Aggregate day/week view showing all profiles' plans, habits, and tasks side by side
- Purely computed from existing `habit_log` + `tasks` + `checkpoints` filtered across `people` — no new storage beyond the Phase 8 `people` tab
- Out of scope: editing another person's plan from this view (view-only; switch profile to edit)

## Out of Scope (entire roadmap)
- Public/verified OAuth (Testing mode + Test Users list only)
- Notifications/reminders
- Native/mobile wrapper — web only

## CLAUDE.md step
Already created per Task #2. Do not mark any phase complete — Phase 0 is in progress, Phase 1 has not started.
