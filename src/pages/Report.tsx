import { useEffect, useState } from 'react';
import * as provider from '../lib/provider';
import { isTaskStale, computeHabitCompletionRate, evaluateWeeklyRule } from '../lib/rules';
import type { Person, Habit, Task, HabitLogRow, WeeklyRule, RewardLogRow } from '../lib/types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Nav } from '../components/Nav';

const REPORT_WINDOW_DAYS = 7;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(dateISO: string, days: number) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export default function Report() {
  const [status, setStatus] = useState('Loading…');
  const [personId, setPersonId] = useState<string | null>(null);
  const [dateRangeLabel, setDateRangeLabel] = useState('');

  const [habits, setHabits] = useState<Habit[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [habitLogRange, setHabitLogRange] = useState<HabitLogRow[]>([]);
  const [weeklyRules, setWeeklyRules] = useState<WeeklyRule[]>([]);
  const [rewardLog, setRewardLog] = useState<RewardLogRow[]>([]);

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

      const fromDate = isoDaysAgo(today, REPORT_WINDOW_DAYS - 1);
      const [habitsResult, tasksResult, habitLogRangeResult, weeklyRulesResult, rewardLogResult] = (await Promise.all([
        provider.getHabits(person.personId),
        provider.getTasks(person.personId),
        provider.getHabitLogRange(person.personId, fromDate, today),
        provider.getWeeklyRules(person.personId),
        provider.getRewardLog(person.personId),
      ])) as [Habit[], Task[], HabitLogRow[], WeeklyRule[], RewardLogRow[]];

      setHabits(habitsResult);
      setTasks(tasksResult);
      setHabitLogRange(habitLogRangeResult);
      setWeeklyRules(weeklyRulesResult);
      setRewardLog(rewardLogResult);
      setStatus(`Report for ${person.name}`);
      setDateRangeLabel(`${fromDate} to ${today}`);
    }

    run().catch((err) => {
      setStatus(`Failed to load: ${err.message}`);
      console.error(err);
    });
  }, []);

  const today = todayISO();
  const openTasks = tasks.filter((t) => t.status === 'pending');

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <Nav personId={personId} />

      <div>
        <h1 className="text-3xl font-semibold">Week Report</h1>
        <p className="text-sm text-muted-foreground">
          {status}
          {dateRangeLabel && ` — ${dateRangeLabel}`}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Habit completion (last {REPORT_WINDOW_DAYS} days)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {habits.length === 0 && <p className="text-sm text-muted-foreground">No habits yet.</p>}
          {habits.map((habit) => {
            const { doneCount, windowDays, rate } = computeHabitCompletionRate(
              habit,
              habitLogRange,
              today,
              REPORT_WINDOW_DAYS
            );
            return (
              <p key={habit.habitId} className="text-sm">
                {habit.label}: {doneCount}/{windowDays} ({Math.round(rate * 100)}%)
              </p>
            );
          })}
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
        </CardHeader>
        <CardContent className="space-y-1">
          {weeklyRules.length === 0 && <p className="text-sm text-muted-foreground">No weekly rules configured.</p>}
          {weeklyRules.map((rule, i) => {
            const result = evaluateWeeklyRule(rule, habitLogRange, today);
            return (
              <p key={i} className="text-sm">
                {rule.metric}: {result.error ?? `${result.count}/${result.target} — ${result.met ? 'met ✅' : 'not met'}`}
              </p>
            );
          })}
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
