// Shapes returned by src/lib/provider.ts, matching SHEET_SCHEMA in
// shared/keystone-provider.js. Added incrementally as pages get ported —
// not a full type overhaul of the provider itself.

export interface Person {
  personId: string;
  name: string;
  theme: string;
  avatar: string;
}

export interface Habit {
  habitId: string;
  personId: string;
  label: string;
  active: boolean;
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
