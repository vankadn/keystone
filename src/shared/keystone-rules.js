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
export function evaluateWeeklyRule(rule, habitLogRows, todayISO) {
  const parsed = parseWeeklyMetric(rule.metric);
  if (!parsed) {
    return { met: false, count: 0, target: 0, error: `Unrecognized metric format: "${rule.metric}"` };
  }
  const { habitId, threshold, windowDays } = parsed;
  const startISO = windowStartISO(todayISO, windowDays);
  const count = habitLogRows.filter((row) =>
    row.habitId === habitId && row.status === 'done' && row.date >= startISO && row.date <= todayISO
  ).length;
  return { met: count >= threshold, count, target: threshold, windowDays };
}

// Habit completion % over a rolling window (default 7 days), for reports.
export function computeHabitCompletionRate(habit, habitLogRows, todayISO, windowDays = 7) {
  const startISO = windowStartISO(todayISO, windowDays);
  const doneCount = habitLogRows.filter((row) =>
    row.habitId === habit.habitId && row.status === 'done' && row.date >= startISO && row.date <= todayISO
  ).length;
  return { doneCount, windowDays, rate: doneCount / windowDays };
}
