// Keystone domain rules — onion-architecture core.
//
// This layer knows the RULES (habit vs task lifecycle, checkpoint
// completion logic) and nothing else. Pure functions only: no fetch, no
// localStorage, no DOM, no imports from keystone-provider.js or src/pages/*.
//
// Dependency direction: UI -> provider, UI -> rules, provider -> rules.
// Never rules -> provider, never rules -> UI. This file has zero imports.

const HABIT_STATUSES = ['done', 'missed'];
const TASK_STATUSES = ['pending', 'done'];
const TASK_STALE_THRESHOLD_DAYS = 7;

export function isValidStatusTransition(itemType, fromStatus, toStatus) {
  const allowed = itemType === 'habit' ? HABIT_STATUSES
    : itemType === 'task' ? TASK_STATUSES
    : null;
  if (!allowed) return false;
  if (fromStatus != null && !allowed.includes(fromStatus)) return false;
  return allowed.includes(toStatus);
}

// Habits with no habit_log row yet for the day being closed out — what
// Plan Tomorrow's close-out action needs to explicitly log as 'missed'.
// A missed day is a fact worth recording, not silence: without this,
// "not logged" and "logged missed" would be indistinguishable later.
// Presence-based on purpose: a habit already carrying a 'skipped' row for
// that date (set at plan time, see keystone-provider.js's setHabitStatus)
// counts as closed too, so close-out never overwrites a skip with 'missed'.
export function getUnclosedHabits(habits, habitLogRows) {
  return habits.filter((habit) => !habitLogRows.some((row) => row.habitId === habit.habitId));
}

export function isTaskStale(task, todayISO) {
  if (task.status !== 'pending') return false;
  const referenceDate = task.lastCarriedDate || task.createdDate;
  if (!referenceDate) return false;
  const start = new Date(`${referenceDate}T00:00:00Z`);
  const end = new Date(`${todayISO}T00:00:00Z`);
  const daysSince = Math.floor((end - start) / (1000 * 60 * 60 * 24));
  return daysSince >= TASK_STALE_THRESHOLD_DAYS;
}

// Surfaces "ready to grant" — never auto-grants. A checkpoint is ready
// when every itemId (habit or task) it references is done.
export function isCheckpointReady(checkpoint, habitLogRows, taskRows) {
  if (checkpoint.status === 'granted') return false;
  return checkpoint.itemIds.every((itemId) => {
    const habitRow = habitLogRows.find((row) => row.habitId === itemId);
    if (habitRow) return habitRow.status === 'done';
    const taskRow = taskRows.find((row) => row.taskId === itemId);
    if (taskRow) return taskRow.status === 'done';
    return false;
  });
}

// A parent can grant a reward regardless of ready-ness (including partial
// completion) — this only guards against granting the same checkpoint twice.
export function canGrantReward(checkpoint) {
  return checkpoint.status !== 'granted';
}

// Data shaping for an open/pool reward picker — no selection logic.
export function resolveOpenRewardChoice(rewardCatalog, rewardIds) {
  return rewardCatalog.filter((reward) => rewardIds.includes(reward.rewardId));
}

// ---- Phase 6: weekly rules + reports ----

// weekly_rules.metric grammar (documented in CLAUDE.md as the source of
// truth): "<habitId>:done>=<N>/<M>" e.g. "h3:done>=5/7" — habitId must
// log >= N 'done' rows within a rolling M-day window ending today.
function parseWeeklyMetric(metric) {
  const match = /^(.+):done>=(\d+)\/(\d+)$/.exec(metric || '');
  if (!match) return null;
  const [, habitId, threshold, windowDays] = match;
  return { habitId, threshold: Number(threshold), windowDays: Number(windowDays) };
}

// Rolling window, not calendar Mon–Sun, so evaluation doesn't jump
// discontinuously at a week boundary — "5 of the last 7 days," always.
function windowStartISO(todayISO, windowDays) {
  const end = new Date(`${todayISO}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - (windowDays - 1));
  return end.toISOString().slice(0, 10);
}

// Pure: takes already-fetched habit_log rows + the date to evaluate
// against, never fetches its own range (that's the provider/UI's job).
//
// 'skipped' days (set at plan time via Plan Tomorrow, see
// keystone-provider.js's setHabitStatus) are neutral: they never count
// toward the N of done>=N/M, but a window with several legitimately-
// skipped days also shouldn't become impossible to meet just because
// fewer days were left where 'done' could ever have been logged. So the
// practical day-count (M) the threshold is measured against shrinks by
// the skipped count within the window — capping what's required at
// whatever's actually left to evaluate, rather than treating skip days
// as compliance failures the way unlogged/'missed' days effectively are.
export function evaluateWeeklyRule(rule, habitLogRows, todayISO) {
  const parsed = parseWeeklyMetric(rule.metric);
  if (!parsed) {
    return { met: false, count: 0, target: 0, error: `Unrecognized metric format: "${rule.metric}"` };
  }
  const { habitId, threshold, windowDays } = parsed;
  const startISO = windowStartISO(todayISO, windowDays);
  const inWindow = (row) => row.habitId === habitId && row.date >= startISO && row.date <= todayISO;
  const count = habitLogRows.filter((row) => inWindow(row) && row.status === 'done').length;
  const skippedCount = habitLogRows.filter((row) => inWindow(row) && row.status === 'skipped').length;
  const effectiveWindowDays = Math.max(windowDays - skippedCount, 0);
  return {
    met: count >= Math.min(threshold, effectiveWindowDays),
    count,
    target: threshold,
    windowDays,
    skippedCount,
  };
}

// Habit completion % over a rolling window (default 7 days), for reports.
// Same 'skipped'-is-neutral treatment as evaluateWeeklyRule above, kept in
// sync deliberately: skip days are excluded from the rate's denominator
// rather than counted as a miss, so a habit paused for a few days (travel,
// illness) doesn't read as a worse completion rate than one genuinely
// missed on those days.
export function computeHabitCompletionRate(habit, habitLogRows, todayISO, windowDays = 7) {
  const startISO = windowStartISO(todayISO, windowDays);
  const inWindow = (row) => row.habitId === habit.habitId && row.date >= startISO && row.date <= todayISO;
  const doneCount = habitLogRows.filter((row) => inWindow(row) && row.status === 'done').length;
  const skippedCount = habitLogRows.filter((row) => inWindow(row) && row.status === 'skipped').length;
  const effectiveWindowDays = Math.max(windowDays - skippedCount, 0);
  return {
    doneCount,
    windowDays,
    skippedCount,
    rate: effectiveWindowDays > 0 ? doneCount / effectiveWindowDays : 1,
  };
}

// ---- Classes: distinct entity from Habits (see CLAUDE.md's Classes phase
// for why) — weekday+time-bound, not daily-reset, with per-occurrence
// override (reschedule) and skip attribution (student vs. teacher). These
// are separate pure functions, not a branch inside the habit ones above —
// evaluateWeeklyRule's grammar/behavior for habits is untouched by this. ----

export const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Which active classes are scheduled on a given calendar date, per their
// daysOfWeek — pure day-of-week match; what time of day is display detail,
// not a scheduling decision this function makes.
export function getExpectedClassesForDate(classes, dateISO) {
  const dayAbbr = DAYS_OF_WEEK[new Date(`${dateISO}T00:00:00Z`).getUTCDay()];
  return classes.filter((klass) => klass.active && klass.daysOfWeek.includes(dayAbbr));
}

// Rolling-window attendance rate for one class. Mirrors
// computeHabitCompletionRate's 'skipped'-is-neutral convention, but only a
// teacher-attributed skip is neutral here — a student skip is a genuine
// miss, which is the entire reason skippedBy exists (see CLAUDE.md). The
// denominator is the count of days the class was actually expected in the
// window (per daysOfWeek), not a flat day count, since classes don't occur
// daily the way habits do.
export function evaluateClassAttendance(klass, classLogRows, todayISO, windowDays = 7) {
  const startISO = windowStartISO(todayISO, windowDays);
  const expectedDates = [];
  for (let offset = 0; offset < windowDays; offset += 1) {
    const d = new Date(`${todayISO}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - offset);
    const dateISO = d.toISOString().slice(0, 10);
    if (dateISO < startISO) break;
    if (getExpectedClassesForDate([klass], dateISO).length > 0) expectedDates.push(dateISO);
  }

  const inWindow = (row) => row.classId === klass.classId && expectedDates.includes(row.date);
  const doneCount = classLogRows.filter((row) => inWindow(row) && row.status === 'done').length;
  const teacherSkipCount = classLogRows.filter(
    (row) => inWindow(row) && row.status === 'skipped' && row.skippedBy === 'teacher'
  ).length;
  const effectiveExpected = Math.max(expectedDates.length - teacherSkipCount, 0);

  return {
    doneCount,
    expectedCount: expectedDates.length,
    teacherSkipCount,
    rate: effectiveExpected > 0 ? doneCount / effectiveExpected : 1,
  };
}

// ---- Phase 11: day sections + arrangement — groundwork for a later
// calendar/specific-time view, not that view itself. Fulfills the
// "Checkpoint time-binding mode" backlog idea for habits/tasks/classes
// (see CLAUDE.md's Future scope section) at the loose/section-grouping
// level; specific-time/calendar-grid binding is still future scope. ----

// Groups a day's habit/task/class items into their assigned day_sections,
// ordered within each section. An item with no day_plan_items row yet for
// this date — brand new, or a date nobody's explicitly arranged — defaults
// to the lowest-sortOrder section rather than being unplaceable, so it
// still shows up somewhere instead of erroring or silently vanishing.
// Same fallback covers an item whose stored sectionId no longer matches
// any current section (i.e. that section was deleted) — see
// deleteDaySection in keystone-provider.js for why no cascade is needed.
//
// Habits vs. Tasks/Classes are asymmetric here (Phase 11 amendment): a
// Habit's section is a fixed property of the habit *definition*
// (`item.sectionId`, set via /habits) — a day_plan_items row for a habit,
// if one exists, only ever supplies `itemSortOrder` (its position within
// that fixed section), never a different section. Tasks and Classes have
// no such home; their section is a free per-day choice that lives purely
// in day_plan_items, exactly as before this amendment.
export function groupItemsBySections(items, sections, dayPlanItems) {
  const sortedSections = [...sections].sort((a, b) => a.sortOrder - b.sortOrder);
  const defaultSectionId = sortedSections[0]?.sectionId ?? null;
  const validSectionIds = new Set(sortedSections.map((s) => s.sectionId));

  const placementFor = (item) => {
    const planRow = dayPlanItems.find((p) => p.itemType === item.itemType && p.itemId === item.itemId);
    if (item.itemType === 'habit') {
      const sectionId = validSectionIds.has(item.sectionId) ? item.sectionId : defaultSectionId;
      const itemSortOrder = planRow ? planRow.itemSortOrder : Number.MAX_SAFE_INTEGER;
      return { sectionId, itemSortOrder };
    }
    if (planRow && validSectionIds.has(planRow.sectionId)) {
      return { sectionId: planRow.sectionId, itemSortOrder: planRow.itemSortOrder };
    }
    return { sectionId: defaultSectionId, itemSortOrder: Number.MAX_SAFE_INTEGER };
  };

  const bySection = new Map(sortedSections.map((s) => [s.sectionId, []]));
  for (const item of items) {
    const { sectionId, itemSortOrder } = placementFor(item);
    const bucket = bySection.get(sectionId);
    if (bucket) bucket.push({ ...item, itemSortOrder });
  }
  for (const bucket of bySection.values()) {
    bucket.sort((a, b) => a.itemSortOrder - b.itemSortOrder);
  }

  return sortedSections.map((section) => ({ section, items: bySection.get(section.sectionId) || [] }));
}
