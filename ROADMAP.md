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

### Phase 2 — Read-only Sheets wiring (anon view)
- Wire provider to real `values.get` calls via API key
- Simple "Today" screen, read-only
- Out of scope: OAuth, writes, checkpoints, rewards

### Phase 3 — OAuth write + Today interactivity
- OAuth sign-in (reuse existing client/scopes)
- Check off habits/tasks, writes to `habit_log`/`tasks`
- Write UI hidden from anon users (`body.anon` pattern, same as Bhajans)
- Out of scope: Plan Tomorrow, checkpoints, rewards, carry-forward logic

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
