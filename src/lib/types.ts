// Shapes returned by src/lib/provider.ts, matching SHEET_SCHEMA in
// shared/keystone-provider.js. Added incrementally as pages get ported —
// not a full type overhaul of the provider itself.

export interface Person {
  personId: string;
  name: string;
  theme: string;
  avatar: string;
}

// sectionId is the habit's fixed home section (Phase 11 amendment) — set
// at creation/edit time via /habits, unlike Task/Class section placement,
// which is a free per-day choice living only in DayPlanItem. See
// CLAUDE.md's Data model section for the full reasoning.
export interface Habit {
  habitId: string;
  personId: string;
  label: string;
  active: boolean;
  sectionId: string;
}

export interface Task {
  taskId: string;
  personId: string;
  label: string;
  createdDate: string;
  dueDate: string;
  status: string;
  lastCarriedDate: string;
}

export interface HabitLogRow {
  date: string;
  personId: string;
  habitId: string;
  status: string;
  checkpointId: string;
}

export interface Checkpoint {
  date: string;
  personId: string;
  checkpointId: string;
  label: string;
  itemIds: string[];
  rewardMode: string;
  rewardIds: string[];
  status: string;
}

export interface Reward {
  rewardId: string;
  personId: string;
  title: string;
  tags: string[];
}

export interface WeeklyRule {
  personId: string;
  metric: string;
  rewardId: string;
}

export interface RewardLogRow {
  date: string;
  personId: string;
  checkpointIdOrWeekId: string;
  rewardChosen: string;
  grantedBy: string;
  status: string;
}

// Distinct from Habit — weekday+time-bound, not daily-reset. See
// CLAUDE.md's Classes phase for why this isn't just a Habit field.
export interface Class {
  classId: string;
  personId: string;
  name: string;
  daysOfWeek: string[];
  startTime: string;
  durationMinutes: number;
  active: boolean;
}

export interface ClassLogRow {
  classId: string;
  personId: string;
  date: string;
  status: string;
  rescheduledTo: string;
  skippedBy: string;
}

// Phase 11 — groundwork for a later calendar/specific-time view, not that
// view itself. See CLAUDE.md's Phase 11 for the full reasoning.
export interface DaySection {
  sectionId: string;
  personId: string;
  name: string;
  sortOrder: number;
}

export type PlanItemType = 'habit' | 'task' | 'class';

// One day's placement of a habit/task/class instance — separate from the
// habits/tasks/classes definition tabs (those stay definitional: what
// recurs). Not append-only, unlike habit_log/class_log: rows here mutate
// in place as the user drags/reassigns.
export interface DayPlanItem {
  personId: string;
  date: string;
  itemType: PlanItemType;
  itemId: string;
  sectionId: string;
  itemSortOrder: number;
}
