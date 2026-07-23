import { useEffect, useMemo, useState } from 'react';
import * as provider from '../lib/provider';
import {
  isTaskStale,
  evaluateWeeklyRule,
  parseWeeklyMetric,
  buildWeeklyMetric,
  calculateAchievementRate,
} from '../lib/rules';
import { requestSignIn, getCachedToken } from '../lib/auth';
import type {
  Person,
  Habit,
  Task,
  HabitLogRow,
  WeeklyRule,
  RewardLogRow,
  Reward,
  Class,
  ClassLogRow,
  AchievementRateResult,
} from '../lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Nav } from '../components/Nav';

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const NO_REWARD = '__none__';

// Rolling day counts ending today, not calendar week/month/year
// boundaries — same convention already established for weekly rules and
// habit completion rate ("not calendar Mon–Sun, so evaluation never
// jumps discontinuously at a boundary"), applied consistently here too.
const PERIOD_DAYS = { Week: 7, Month: 30, Year: 365 } as const;
type Period = keyof typeof PERIOD_DAYS;
// Widest period's day count — habit_log/class_log are fetched once for
// this whole range up front, so switching the period selector is an
// instant client-side recompute over already-loaded rows, not a re-fetch
// (matters given this project's read-quota history — see CLAUDE.md).
const MAX_PERIOD_DAYS = Math.max(...Object.values(PERIOD_DAYS));

// Local calendar date, NOT `new Date().toISOString()` — see
// keystone-provider.js's todayISO() for why (UTC disagrees with the
// user's actual local day for part of every day in any timezone ahead
// of UTC).
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoDaysAgo(dateISO: string, days: number) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Weekly rules are composed from a habit picker + two number inputs, never
// typed/edited as the raw "<habitId>:done>=<N>/<M>" grammar string — see
// buildWeeklyMetric/parseWeeklyMetric in keystone-rules.js. Shared by the
// add form and each existing rule's inline edit row below.
function WeeklyRuleFields({
  habits,
  rewardCatalog,
  habitId,
  threshold,
  windowDays,
  rewardId,
  onHabitIdChange,
  onThresholdChange,
  onWindowDaysChange,
  onRewardIdChange,
  disabled,
}: {
  habits: Habit[];
  rewardCatalog: Reward[];
  habitId: string;
  threshold: string;
  windowDays: string;
  rewardId: string;
  onHabitIdChange: (value: string) => void;
  onThresholdChange: (value: string) => void;
  onWindowDaysChange: (value: string) => void;
  onRewardIdChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={habitId} onValueChange={(value) => onHabitIdChange(value as string)} disabled={disabled}>
        <SelectTrigger className="w-40">
          <SelectValue placeholder="Habit" />
        </SelectTrigger>
        <SelectContent>
          {habits.map((habit) => (
            <SelectItem key={habit.habitId} value={habit.habitId}>
              {habit.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-sm text-muted-foreground">done ≥</span>
      <Input
        type="number"
        min="0"
        value={threshold}
        disabled={disabled}
        onChange={(e) => onThresholdChange(e.target.value)}
        className="w-16"
      />
      <span className="text-sm text-muted-foreground">/ last</span>
      <Input
        type="number"
        min="1"
        value={windowDays}
        disabled={disabled}
        onChange={(e) => onWindowDaysChange(e.target.value)}
        className="w-16"
      />
      <span className="text-sm text-muted-foreground">days</span>
      <Select value={rewardId || NO_REWARD} onValueChange={(value) => onRewardIdChange(value as string)} disabled={disabled}>
        <SelectTrigger className="w-40">
          <SelectValue placeholder="Reward (optional)" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_REWARD}>No linked reward</SelectItem>
          {rewardCatalog.map((reward) => (
            <SelectItem key={reward.rewardId} value={reward.rewardId}>
              {reward.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function WeeklyRuleRow({
  rule,
  habits,
  rewardCatalog,
  busy,
  onSave,
  onDelete,
}: {
  rule: WeeklyRule;
  habits: Habit[];
  rewardCatalog: Reward[];
  busy: boolean;
  onSave: (ruleId: string, metric: string, rewardId: string) => void;
  onDelete: (ruleId: string) => void;
}) {
  const parsed = parseWeeklyMetric(rule.metric);
  const [habitId, setHabitId] = useState(parsed?.habitId ?? '');
  const [threshold, setThreshold] = useState(String(parsed?.threshold ?? ''));
  const [windowDays, setWindowDays] = useState(String(parsed?.windowDays ?? ''));
  const [rewardId, setRewardId] = useState(rule.rewardId);

  const n = Number(threshold);
  const m = Number(windowDays);
  const valid = habitId && n > 0 && m > 0 && n <= m;
  const metric = valid ? buildWeeklyMetric(habitId, n, m) : '';
  const dirty = valid && (metric !== rule.metric || rewardId !== rule.rewardId);

  if (!parsed) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-destructive">Unrecognized metric: "{rule.metric}"</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDelete(rule.ruleId)}>
          Delete
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b pb-2 last:border-b-0 last:pb-0">
      <WeeklyRuleFields
        habits={habits}
        rewardCatalog={rewardCatalog}
        habitId={habitId}
        threshold={threshold}
        windowDays={windowDays}
        rewardId={rewardId}
        onHabitIdChange={setHabitId}
        onThresholdChange={setThreshold}
        onWindowDaysChange={setWindowDays}
        onRewardIdChange={(value) => setRewardId(value === NO_REWARD ? '' : value)}
        disabled={busy}
      />
      {n > 0 && m > 0 && n > m && <span className="text-xs text-destructive">N can't exceed M</span>}
      {dirty && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onSave(rule.ruleId, metric, rewardId)}>
          Save
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDelete(rule.ruleId)}>
        Delete
      </Button>
    </div>
  );
}

export default function Report() {
  const [status, setStatus] = useState('Loading…');
  const [writeError, setWriteError] = useState('');
  const [isAuthed, setIsAuthed] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);
  const [personId, setPersonId] = useState<string | null>(null);

  const [habits, setHabits] = useState<Habit[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [habitLogRange, setHabitLogRange] = useState<HabitLogRow[]>([]);
  const [weeklyRules, setWeeklyRules] = useState<WeeklyRule[]>([]);
  const [rewardLog, setRewardLog] = useState<RewardLogRow[]>([]);
  const [rewardCatalog, setRewardCatalog] = useState<Reward[]>([]);
  const [classes, setClasses] = useState<Class[]>([]);
  const [classLogRange, setClassLogRange] = useState<ClassLogRow[]>([]);
  const [period, setPeriod] = useState<Period>('Week');

  const [newRuleHabitId, setNewRuleHabitId] = useState('');
  const [newRuleThreshold, setNewRuleThreshold] = useState('');
  const [newRuleWindowDays, setNewRuleWindowDays] = useState('7');
  const [newRuleRewardId, setNewRuleRewardId] = useState('');
  const [addRuleBusy, setAddRuleBusy] = useState(false);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);

  useEffect(() => {
    const cached = getCachedToken();
    if (cached) {
      provider.setAccessToken(cached);
      setIsAuthed(true);
    }
  }, []);

  async function reloadWeeklyRules(forPersonId: string) {
    setWeeklyRules((await provider.getWeeklyRules(forPersonId)) as WeeklyRule[]);
  }

  useEffect(() => {
    async function run() {
      const params = new URLSearchParams(window.location.search);
      const requestedPersonId = params.get('personId');
      const today = todayISO();

      const people = (await provider.getPeople()) as Person[];
      const person = people.find((p) => p.personId === requestedPersonId) || people[0] || null;

      if (!person) {
        setStatus('No people found — add one from the Today page first.');
        return;
      }
      setPersonId(person.personId);

      // Fetched once, wide enough for the largest selectable period
      // (Year) — switching Week/Month/Year afterward is a client-side
      // recompute over this same data, not a re-fetch.
      const fromDate = isoDaysAgo(today, MAX_PERIOD_DAYS - 1);
      const [
        habitsResult,
        tasksResult,
        habitLogRangeResult,
        weeklyRulesResult,
        rewardLogResult,
        rewardCatalogResult,
        classesResult,
        classLogRangeResult,
      ] = (await Promise.all([
        provider.getHabits(person.personId),
        provider.getTasks(person.personId),
        provider.getHabitLogRange(person.personId, fromDate, today),
        provider.getWeeklyRules(person.personId),
        provider.getRewardLog(person.personId),
        provider.getRewardCatalog(person.personId),
        provider.getClasses(person.personId),
        provider.getClassLogRange(person.personId, fromDate, today),
      ])) as [
        Habit[],
        Task[],
        HabitLogRow[],
        WeeklyRule[],
        RewardLogRow[],
        Reward[],
        Class[],
        ClassLogRow[],
      ];

      setHabits(habitsResult);
      setTasks(tasksResult);
      setHabitLogRange(habitLogRangeResult);
      setWeeklyRules(weeklyRulesResult);
      setRewardLog(rewardLogResult);
      setRewardCatalog(rewardCatalogResult);
      setClasses(classesResult);
      setClassLogRange(classLogRangeResult);
      setStatus(`Report for ${person.name}`);
    }

    run().catch((err) => {
      setStatus(`Failed to load: ${err.message}`);
      console.error(err);
    });
  }, []);

  async function handleSignIn() {
    setSignInBusy(true);
    setWriteError('');
    try {
      const token = await requestSignIn(window.KEYSTONE_CONFIG.oauthClientId, OAUTH_SCOPE);
      provider.setAccessToken(token);
      setIsAuthed(true);
    } catch (err) {
      setWriteError(`Sign-in failed: ${(err as Error).message}`);
    } finally {
      setSignInBusy(false);
    }
  }

  async function handleAddWeeklyRule(event: React.FormEvent) {
    event.preventDefault();
    if (!personId) return;
    const n = Number(newRuleThreshold);
    const m = Number(newRuleWindowDays);
    if (!newRuleHabitId || !(n > 0) || !(m > 0) || n > m) return;

    setAddRuleBusy(true);
    setWriteError('');
    try {
      const metric = buildWeeklyMetric(newRuleHabitId, n, m);
      await provider.addWeeklyRule(personId, metric, newRuleRewardId);
      await reloadWeeklyRules(personId);
      setNewRuleHabitId('');
      setNewRuleThreshold('');
      setNewRuleWindowDays('7');
      setNewRuleRewardId('');
    } catch (err) {
      setWriteError(`Failed to add weekly rule: ${(err as Error).message}`);
    } finally {
      setAddRuleBusy(false);
    }
  }

  async function handleSaveWeeklyRule(ruleId: string, metric: string, rewardId: string) {
    if (!personId) return;
    setBusyRuleId(ruleId);
    setWriteError('');
    try {
      await provider.updateWeeklyRule(ruleId, metric, rewardId);
      await reloadWeeklyRules(personId);
    } catch (err) {
      setWriteError(`Failed to update weekly rule: ${(err as Error).message}`);
    } finally {
      setBusyRuleId(null);
    }
  }

  async function handleDeleteWeeklyRule(ruleId: string) {
    if (!personId) return;
    setBusyRuleId(ruleId);
    setWriteError('');
    try {
      await provider.deleteWeeklyRule(ruleId);
      await reloadWeeklyRules(personId);
    } catch (err) {
      setWriteError(`Failed to delete weekly rule: ${(err as Error).message}`);
    } finally {
      setBusyRuleId(null);
    }
  }

  const today = todayISO();
  const openTasks = tasks.filter((t) => t.status === 'pending');
  const activeHabits = habits.filter((h) => h.active);
  const newRuleN = Number(newRuleThreshold);
  const newRuleM = Number(newRuleWindowDays);
  const newRuleValid = Boolean(newRuleHabitId) && newRuleN > 0 && newRuleM > 0 && newRuleN <= newRuleM;

  const periodStart = isoDaysAgo(today, PERIOD_DAYS[period] - 1);
  const periodEnd = today;

  const habitAchievement = useMemo(
    () =>
      (personId
        ? calculateAchievementRate(habitLogRange, habits, 'habit', personId, periodStart, periodEnd)
        : []) as AchievementRateResult[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [habitLogRange, habits, personId, periodStart, periodEnd]
  );
  const classAchievement = useMemo(
    () =>
      (personId
        ? calculateAchievementRate(classLogRange, classes, 'class', personId, periodStart, periodEnd)
        : []) as AchievementRateResult[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [classLogRange, classes, personId, periodStart, periodEnd]
  );
  const taskAchievement = useMemo(
    () =>
      (personId
        ? calculateAchievementRate([], tasks, 'task', personId, periodStart, periodEnd)
        : []) as AchievementRateResult[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, personId, periodStart, periodEnd]
  );

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <Nav personId={personId} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Report</h1>
          <p className="text-sm text-muted-foreground">
            {status}
            {personId && ` — ${periodStart} to ${periodEnd}`}
          </p>
        </div>
        {!isAuthed && (
          <Button onClick={handleSignIn} disabled={signInBusy}>
            Sign in
          </Button>
        )}
      </div>

      {writeError && <p className="text-sm text-destructive">{writeError}</p>}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Achievement</CardTitle>
            <Select value={period} onValueChange={(value) => setPeriod(value as Period)}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PERIOD_DAYS) as Period[]).map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-sm text-muted-foreground">
            Per-item completion rate, not a blended average — each habit/task/class shown individually.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Habits</p>
            {habitAchievement.length === 0 && <p className="text-sm text-muted-foreground">No habits yet.</p>}
            {habitAchievement.map((result) => (
              <p key={result.itemId} className="text-sm">
                {result.label}: {result.completed}/{result.expected} ({Math.round(result.rate * 100)}%)
              </p>
            ))}
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">Classes</p>
            {classAchievement.length === 0 && <p className="text-sm text-muted-foreground">No classes yet.</p>}
            {classAchievement.map((result) => (
              <p key={result.itemId} className="text-sm">
                {result.label}: {result.completed}/{result.expected} ({Math.round(result.rate * 100)}%)
              </p>
            ))}
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">Tasks (created this period)</p>
            {taskAchievement.length === 0 && (
              <p className="text-sm text-muted-foreground">No tasks created in this period.</p>
            )}
            {taskAchievement.map((result) => (
              <p key={result.itemId} className="text-sm">
                {result.label}: {result.rate === 1 ? 'Done' : 'Not done'}
              </p>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Task aging</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {openTasks.length === 0 && <p className="text-sm text-muted-foreground">No open tasks.</p>}
          {openTasks.map((task) => {
            const stale = isTaskStale(task, today);
            const referenceDate = task.lastCarriedDate || task.createdDate;
            return (
              <p key={task.taskId} className="text-sm">
                {task.label} — open since {referenceDate}
                {stale && <span className="text-destructive"> [stale]</span>}
              </p>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Weekly rules</CardTitle>
          <p className="text-sm text-muted-foreground">
            A rule needs a habit to have &gt;= N 'done' days within a rolling M-day window. Composed from
            the fields below — never typed as a raw grammar string.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {weeklyRules.length === 0 && <p className="text-sm text-muted-foreground">No weekly rules configured.</p>}
          {weeklyRules.map((rule) => {
            const result = evaluateWeeklyRule(rule, habitLogRange, today);
            return (
              <div key={rule.ruleId} className="space-y-1">
                <p className="text-sm">
                  {rule.metric}: {result.error ?? `${result.count}/${result.target} — ${result.met ? 'met ✅' : 'not met'}`}
                  {!result.error && result.skippedCount > 0 && ` (${result.skippedCount} skipped)`}
                </p>
                {isAuthed && (
                  <WeeklyRuleRow
                    rule={rule}
                    habits={activeHabits}
                    rewardCatalog={rewardCatalog}
                    busy={busyRuleId === rule.ruleId}
                    onSave={handleSaveWeeklyRule}
                    onDelete={handleDeleteWeeklyRule}
                  />
                )}
              </div>
            );
          })}

          {isAuthed && (
            <form onSubmit={handleAddWeeklyRule} className="space-y-2 border-t pt-3">
              <p className="text-sm font-medium">Add a weekly rule</p>
              <WeeklyRuleFields
                habits={activeHabits}
                rewardCatalog={rewardCatalog}
                habitId={newRuleHabitId}
                threshold={newRuleThreshold}
                windowDays={newRuleWindowDays}
                rewardId={newRuleRewardId}
                onHabitIdChange={setNewRuleHabitId}
                onThresholdChange={setNewRuleThreshold}
                onWindowDaysChange={setNewRuleWindowDays}
                onRewardIdChange={(value) => setNewRuleRewardId(value === NO_REWARD ? '' : value)}
                disabled={addRuleBusy}
              />
              {newRuleN > 0 && newRuleM > 0 && newRuleN > newRuleM && (
                <p className="text-xs text-destructive">N can't exceed M — the window doesn't have that many days.</p>
              )}
              <Button type="submit" disabled={!newRuleValid || addRuleBusy}>
                Add Rule
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reward history</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {rewardLog.length === 0 && <p className="text-sm text-muted-foreground">No rewards granted yet.</p>}
          {rewardLog.map((row, i) => (
            <p key={i} className="text-sm">
              {row.date}: {row.rewardChosen} ({row.status}, granted by {row.grantedBy})
            </p>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
