// Keystone domain rules — onion-architecture core.
//
// This layer knows the RULES (habit vs task lifecycle, checkpoint
// completion logic) and nothing else. Pure functions only: no fetch, no
// localStorage, no DOM, no imports from keystone-provider.js or app/*.
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
