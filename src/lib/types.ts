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
// pointValue (Phase 12) is snapshotted into points_log at the moment a
// completion earns points — editing it later never rewrites history, see
// CLAUDE.md's Phase 12 for the full ledger reasoning.
export interface Habit {
  habitId: string;
  personId: string;
  label: string;
  active: boolean;
  sectionId: string;
  pointValue: number;
}

export interface Task {
  taskId: string;
  personId: string;
  label: string;
  createdDate: string;
  dueDate: string;
  status: string;
  lastCarriedDate: string;
  pointValue: number;
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
  ruleId: string;
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
  pointValue: number;
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
// startTime ("HH:MM", optional/blank for a custom section nobody's set a
// time on) is the section's own clock-time boundary, used to default-
// bucket an unplaced Class (which has its own startTime) into whichever
// section it actually falls into — see groupItemsBySections in
// keystone-rules.js. sortOrder is purely display order and has no time
// meaning of its own.
export interface DaySection {
  sectionId: string;
  personId: string;
  name: string;
  sortOrder: number;
  startTime: string;
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

// Phase 12 — flat per-item points, alongside (not replacing) the
// checkpoint/parent-granted reward model. See CLAUDE.md's Phase 12 for
// the ledger-not-mutable-balance design decision.
export interface PointsLogRow {
  personId: string;
  date: string;
  itemType: PlanItemType;
  itemId: string;
  pointsEarned: number;
}

// No personId — a shared family catalog, unlike Reward (reward_catalog),
// which is per-person. See keystone-provider.js's points_rewards section.
export interface PointsReward {
  rewardId: string;
  name: string;
  pointCost: number;
}

export interface PointsRedemptionRow {
  personId: string;
  rewardId: string;
  date: string;
  pointsSpent: number;
}

export interface PointsBalance {
  earned: number;
  spent: number;
  balance: number;
}

// Phase 13 — auto-granted, no parent confirmation, deliberately unlike
// checkpoints/points-catalog redemption. See CLAUDE.md's Phase 13 for
// why (and for the redeem-safety reasoning behind how grants are
// computed, in computeMilestoneGrantsDue).
export interface PointsMilestone {
  milestoneId: string;
  personId: string;
  pointInterval: number;
  rewardDescription: string;
}

export interface MilestoneGrantRow {
  personId: string;
  milestoneId: string;
  date: string;
  pointsBalanceAtGrant: number;
}

// Return shape of calculateAchievementRate — one entry per item, not a
// blended average. See CLAUDE.md's Phase 13 for the per-item-type
// (habit/class/task) denominator conventions.
export interface AchievementRateResult {
  itemId: string;
  label: string;
  completed: number;
  expected: number;
  rate: number;
}
