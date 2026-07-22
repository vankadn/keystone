import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import * as provider from '../lib/provider';
import {
  isTaskStale,
  isCheckpointReady,
  isValidStatusTransition,
  getExpectedClassesForDate,
  groupItemsBySections,
} from '../lib/rules';
import { requestSignIn, getCachedToken } from '../lib/auth';
import type {
  Person,
  Habit,
  Task,
  HabitLogRow,
  Checkpoint,
  Class,
  ClassLogRow,
  DaySection,
  DayPlanItem,
  PlanItemType,
  PointsBalance,
  MilestoneGrantRow,
} from '../lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Nav } from '../components/Nav';
import { DayPlanBoard } from '../components/DayPlanBoard';

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const today = todayISO();

type TodayPlanItemBase =
  // sectionId here is read directly by groupItemsBySections (habits'
  // fixed home section, see keystone-rules.js) — it's not just along for
  // the ride on `habit`, the grouping function looks at the top-level field.
  | { itemType: 'habit'; itemId: string; sectionId: string; habit: Habit }
  | { itemType: 'task'; itemId: string; task: Task }
  | { itemType: 'class'; itemId: string; klass: Class };

type TodayPlanItem = TodayPlanItemBase & { itemSortOrder: number };

// Same-day actions for one expected class: mark done, skip (defaults to
// 'student'; "Skip (teacher)" is the one-extra-click exception path, not
// a separate form), or reschedule to a new date/time. Once class_log has
// a row for today, swap to a plain status line — same pattern as
// Checkpoints' "Already granted" once an action has been taken.
function ClassRow({
  klass,
  logRow,
  busy,
  onDone,
  onSkip,
  onReschedule,
}: {
  klass: Class;
  logRow: ClassLogRow | null;
  busy: boolean;
  onDone: (klass: Class) => void;
  onSkip: (klass: Class, skippedBy: 'student' | 'teacher') => void;
  onReschedule: (klass: Class, rescheduledTo: string) => void;
}) {
  const [rescheduling, setRescheduling] = useState(false);
  const [rescheduledTo, setRescheduledTo] = useState('');

  if (logRow) {
    const statusText =
      logRow.status === 'done'
        ? 'Done'
        : logRow.status === 'skipped'
          ? `Skipped (${logRow.skippedBy || 'student'})`
          : `Rescheduled to ${logRow.rescheduledTo}`;
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">
          {klass.startTime} — {klass.name}
        </span>
        <span className="text-xs text-muted-foreground">{statusText}</span>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">
          {klass.startTime} — {klass.name}
        </span>
        <div className="flex gap-1">
          <Button size="sm" disabled={busy} onClick={() => onDone(klass)}>
            Done
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onSkip(klass, 'student')}>
            Skip
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSkip(klass, 'teacher')}>
            Skip (teacher)
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setRescheduling((v) => !v)}>
            Reschedule
          </Button>
        </div>
      </div>
      {rescheduling && (
        <div className="flex items-center gap-2 pl-2">
          <Input
            type="datetime-local"
            value={rescheduledTo}
            onChange={(e) => setRescheduledTo(e.target.value)}
            className="w-56"
          />
          <Button
            size="sm"
            disabled={busy || !rescheduledTo}
            onClick={() => {
              onReschedule(klass, rescheduledTo);
              setRescheduling(false);
            }}
          >
            Confirm
          </Button>
        </div>
      )}
    </div>
  );
}

export default function Today() {
  const [status, setStatus] = useState('Loading…');
  const [writeError, setWriteError] = useState('');
  const [isAuthed, setIsAuthed] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);

  const [currentPerson, setCurrentPerson] = useState<Person | null>(null);
  const [peopleChecked, setPeopleChecked] = useState(false);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [habitLog, setHabitLog] = useState<HabitLogRow[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [expectedClasses, setExpectedClasses] = useState<Class[]>([]);
  const [classLog, setClassLog] = useState<ClassLogRow[]>([]);
  const [sections, setSections] = useState<DaySection[]>([]);
  const [dayPlanItems, setDayPlanItems] = useState<DayPlanItem[]>([]);
  const [pointsBalance, setPointsBalance] = useState<PointsBalance | null>(null);
  const [milestoneGrants, setMilestoneGrants] = useState<MilestoneGrantRow[]>([]);

  const [addPersonName, setAddPersonName] = useState('');
  const [addPersonTheme, setAddPersonTheme] = useState('Playful');
  const [addPersonBusy, setAddPersonBusy] = useState(false);

  const [busyHabitId, setBusyHabitId] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [busyClassId, setBusyClassId] = useState<string | null>(null);

  useEffect(() => {
    const cached = getCachedToken();
    if (cached) {
      provider.setAccessToken(cached);
      setIsAuthed(true);
    }
  }, []);

  useEffect(() => {
    async function run() {
      const params = new URLSearchParams(window.location.search);
      const requestedPersonId = params.get('personId');

      const people = (await provider.getPeople()) as Person[];
      const person = people.find((p) => p.personId === requestedPersonId) || people[0] || null;
      setCurrentPerson(person);
      setPeopleChecked(true);

      if (!person) {
        setStatus('No people yet — sign in to add the first person.');
        return;
      }

      const [
        habitsResult,
        tasksResult,
        habitLogResult,
        checkpointsResult,
        classesResult,
        classLogResult,
        sectionsResult,
        dayPlanResult,
        pointsBalanceResult,
        milestoneGrantsResult,
      ] = (await Promise.all([
        provider.getHabits(person.personId),
        provider.getTasks(person.personId),
        provider.getHabitLog(person.personId, today),
        provider.getCheckpoints(person.personId, today),
        provider.getClasses(person.personId),
        provider.getClassLog(person.personId, today),
        provider.getDaySections(person.personId),
        provider.getDayPlan(person.personId, today),
        provider.getPointsBalance(person.personId),
        provider.getMilestoneGrantsLog(person.personId),
      ])) as [
        Habit[],
        Task[],
        HabitLogRow[],
        Checkpoint[],
        Class[],
        ClassLogRow[],
        DaySection[],
        DayPlanItem[],
        PointsBalance,
        MilestoneGrantRow[],
      ];

      setHabits(habitsResult.filter((h) => h.active));
      setTasks(tasksResult);
      setHabitLog(habitLogResult);
      setCheckpoints(checkpointsResult);
      setExpectedClasses(getExpectedClassesForDate(classesResult, today) as Class[]);
      setClassLog(classLogResult);
      setSections(sectionsResult);
      setDayPlanItems(dayPlanResult);
      setPointsBalance(pointsBalanceResult);
      setMilestoneGrants(milestoneGrantsResult);
      setStatus(`Showing ${today} for ${person.name}`);
    }

    run().catch((err) => {
      setStatus(`Failed to load: ${err.message}`);
      console.error(err);
    });
    // Runs once on mount, same as the original today.html's run().
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function handleAddPerson(event: React.FormEvent) {
    event.preventDefault();
    const name = addPersonName.trim();
    if (!name) return;

    setAddPersonBusy(true);
    setWriteError('');
    try {
      const person = await provider.addPerson(name, addPersonTheme);
      const url = new URL(window.location.href);
      url.searchParams.set('personId', person.personId);
      window.location.href = url.toString();
    } catch (err) {
      setWriteError(`Failed to add person: ${(err as Error).message}`);
      setAddPersonBusy(false);
    }
  }

  // Called after any action that might have earned/reversed points
  // (habit/task done<->not-done, class done) so the header balance stays
  // current — points aren't part of the optimistic local-state updates
  // those handlers already do, since the delta is decided server-side
  // (see setHabitStatus/setTaskStatus/logClassStatus in
  // keystone-provider.js), so re-fetching the derived balance is simplest.
  async function refreshPointsBalance() {
    if (!currentPerson) return;
    try {
      // A single completion can both earn points and cross a milestone
      // (checkAndGrantMilestones runs inside awardPoints server-side) —
      // refresh both together so the header stays consistent.
      const [balanceResult, grantsResult] = await Promise.all([
        provider.getPointsBalance(currentPerson.personId),
        provider.getMilestoneGrantsLog(currentPerson.personId),
      ]);
      setPointsBalance(balanceResult as PointsBalance);
      setMilestoneGrants(grantsResult as MilestoneGrantRow[]);
    } catch {
      // Non-critical — the balance display just stays stale until the
      // next successful refresh; don't surface this as a writeError.
    }
  }

  async function handleHabitToggle(habit: Habit, checked: boolean, previousStatus: string | null) {
    const toStatus = checked ? 'done' : 'missed';
    if (!isValidStatusTransition('habit', previousStatus, toStatus)) return;

    setBusyHabitId(habit.habitId);
    setWriteError('');
    try {
      await provider.setHabitStatus(today, habit.habitId, toStatus, previousStatus);
      setHabitLog((rows) => [
        ...rows.filter((row) => row.habitId !== habit.habitId),
        { date: today, personId: currentPerson!.personId, habitId: habit.habitId, status: toStatus, checkpointId: '' },
      ]);
      await refreshPointsBalance();
    } catch (err) {
      setWriteError(`Failed to save "${habit.label}": ${(err as Error).message}`);
    } finally {
      setBusyHabitId(null);
    }
  }

  async function handleTaskToggle(task: Task, checked: boolean) {
    const toStatus = checked ? 'done' : 'pending';
    if (!isValidStatusTransition('task', task.status, toStatus)) return;

    setBusyTaskId(task.taskId);
    setWriteError('');
    try {
      const updated = await provider.setTaskStatus(task.taskId, toStatus);
      setTasks((rows) => rows.map((t) => (t.taskId === task.taskId ? { ...t, ...updated } : t)));
      await refreshPointsBalance();
    } catch (err) {
      setWriteError(`Failed to save "${task.label}": ${(err as Error).message}`);
    } finally {
      setBusyTaskId(null);
    }
  }

  async function handleClassDone(klass: Class) {
    setBusyClassId(klass.classId);
    setWriteError('');
    try {
      const row = (await provider.logClassStatus(klass.classId, currentPerson!.personId, today, 'done')) as ClassLogRow;
      setClassLog((rows) => [...rows.filter((r) => r.classId !== klass.classId), row]);
      await refreshPointsBalance();
    } catch (err) {
      setWriteError(`Failed to log "${klass.name}": ${(err as Error).message}`);
    } finally {
      setBusyClassId(null);
    }
  }

  async function handleClassSkip(klass: Class, skippedBy: 'student' | 'teacher') {
    setBusyClassId(klass.classId);
    setWriteError('');
    try {
      const row = (await provider.logClassStatus(klass.classId, currentPerson!.personId, today, 'skipped', {
        skippedBy,
      })) as ClassLogRow;
      setClassLog((rows) => [...rows.filter((r) => r.classId !== klass.classId), row]);
    } catch (err) {
      setWriteError(`Failed to skip "${klass.name}": ${(err as Error).message}`);
    } finally {
      setBusyClassId(null);
    }
  }

  async function handleClassReschedule(klass: Class, rescheduledTo: string) {
    setBusyClassId(klass.classId);
    setWriteError('');
    try {
      const row = (await provider.logClassStatus(klass.classId, currentPerson!.personId, today, 'rescheduled', {
        rescheduledTo,
      })) as ClassLogRow;
      setClassLog((rows) => [...rows.filter((r) => r.classId !== klass.classId), row]);
    } catch (err) {
      setWriteError(`Failed to reschedule "${klass.name}": ${(err as Error).message}`);
    } finally {
      setBusyClassId(null);
    }
  }

  async function handleMove(itemType: PlanItemType, itemId: string, sectionId: string, itemSortOrder: number) {
    if (!currentPerson) return;
    setWriteError('');
    try {
      const row = (await provider.upsertDayPlanItem(
        currentPerson.personId,
        today,
        itemType,
        itemId,
        sectionId,
        itemSortOrder
      )) as DayPlanItem;
      setDayPlanItems((rows) => [...rows.filter((r) => !(r.itemType === itemType && r.itemId === itemId)), row]);
    } catch (err) {
      setWriteError(`Failed to move item: ${(err as Error).message}`);
    }
  }

  const planItemsBase: TodayPlanItemBase[] = [
    ...habits.map((habit) => ({ itemType: 'habit' as const, itemId: habit.habitId, sectionId: habit.sectionId, habit })),
    ...tasks.map((task) => ({ itemType: 'task' as const, itemId: task.taskId, task })),
    ...expectedClasses.map((klass) => ({ itemType: 'class' as const, itemId: klass.classId, klass })),
  ];
  const grouped = useMemo(
    () =>
      groupItemsBySections(planItemsBase, sections, dayPlanItems) as {
        section: DaySection;
        items: TodayPlanItem[];
      }[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [habits, tasks, expectedClasses, sections, dayPlanItems]
  );

  function renderPlanItem(item: TodayPlanItem) {
    if (item.itemType === 'habit') {
      const habit = item.habit;
      const logRow = habitLog.find((row) => row.habitId === habit.habitId);
      const habitStatus = logRow ? logRow.status : null;
      return (
        <div className="flex items-center gap-2">
          {isAuthed && habitStatus !== 'skipped' && (
            <Checkbox
              checked={habitStatus === 'done'}
              disabled={busyHabitId === habit.habitId}
              onCheckedChange={(checked) => handleHabitToggle(habit, checked, habitStatus)}
            />
          )}
          <span className="text-sm">
            {habit.label} — {habitStatus || 'not logged'}
          </span>
        </div>
      );
    }
    if (item.itemType === 'task') {
      const task = item.task;
      const stale = isTaskStale(task, today);
      return (
        <div className="flex items-center gap-2">
          {isAuthed && (
            <Checkbox
              checked={task.status === 'done'}
              disabled={busyTaskId === task.taskId}
              onCheckedChange={(checked) => handleTaskToggle(task, checked)}
            />
          )}
          <span className="text-sm">
            {task.label} — {task.status}
            {stale && <span className="text-destructive"> [stale]</span>}
          </span>
        </div>
      );
    }
    const klass = item.klass;
    if (!isAuthed) {
      return (
        <p className="text-sm">
          {klass.startTime} — {klass.name}
        </p>
      );
    }
    return (
      <ClassRow
        klass={klass}
        logRow={classLog.find((row) => row.classId === klass.classId) ?? null}
        busy={busyClassId === klass.classId}
        onDone={handleClassDone}
        onSkip={handleClassSkip}
        onReschedule={handleClassReschedule}
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <Nav personId={currentPerson?.personId ?? null} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Today</h1>
          <p className="text-sm text-muted-foreground">
            {status}
            {pointsBalance && ` — ${pointsBalance.balance} pts`}
            {milestoneGrants.length > 0 && ` · ${milestoneGrants.length} milestone${milestoneGrants.length === 1 ? '' : 's'} earned`}
          </p>
          {currentPerson && (
            <Link
              to={`/plan?date=${today}${currentPerson.personId ? `&personId=${currentPerson.personId}` : ''}`}
              className="text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              Adjust today's plan
            </Link>
          )}
        </div>
        {!isAuthed && (
          <Button onClick={handleSignIn} disabled={signInBusy}>
            Sign in
          </Button>
        )}
      </div>

      {writeError && <p className="text-sm text-destructive">{writeError}</p>}

      {peopleChecked && !currentPerson && isAuthed && (
        <Card>
          <CardHeader>
            <CardTitle>Add Person</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAddPerson} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="add-person-name">Name</Label>
                <Input
                  id="add-person-name"
                  required
                  value={addPersonName}
                  onChange={(e) => setAddPersonName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Theme</Label>
                <Select value={addPersonTheme} onValueChange={(value) => setAddPersonTheme(value as string)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Playful">Playful</SelectItem>
                    <SelectItem value="Minimal">Minimal</SelectItem>
                    <SelectItem value="Warm">Warm</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={addPersonBusy}>
                Add Person
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {currentPerson && (
        <>
          {isAuthed ? (
            <DayPlanBoard grouped={grouped} onMove={handleMove} renderItem={renderPlanItem} />
          ) : (
            <div className="space-y-4">
              {grouped.map(({ section, items }) => (
                <Card key={section.sectionId}>
                  <CardHeader>
                    <CardTitle>{section.name}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {items.length === 0 && <p className="text-sm text-muted-foreground">Nothing here.</p>}
                    {items.map((item) => (
                      <div key={`${item.itemType}:${item.itemId}`}>{renderPlanItem(item)}</div>
                    ))}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Checkpoints</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {checkpoints.length === 0 && <p className="text-sm text-muted-foreground">No checkpoints today.</p>}
              {checkpoints.map((checkpoint) => {
                const ready = isCheckpointReady(checkpoint, habitLog, tasks);
                return (
                  <p key={checkpoint.checkpointId} className="text-sm">
                    {checkpoint.label} — {checkpoint.status}
                    {ready && <span className="text-primary"> [ready to grant]</span>}
                  </p>
                );
              })}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
