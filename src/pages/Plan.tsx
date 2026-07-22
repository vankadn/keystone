import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as provider from '../lib/provider';
import { isTaskStale, getUnclosedHabits, getExpectedClassesForDate, groupItemsBySections } from '../lib/rules';
import { requestSignIn, getCachedToken } from '../lib/auth';
import type {
  Person,
  Habit,
  Task,
  HabitLogRow,
  Class,
  ClassLogRow,
  DaySection,
  DayPlanItem,
  PlanItemType,
} from '../lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Nav } from '../components/Nav';
import { DayPlanBoard } from '../components/DayPlanBoard';

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DATE_PARAM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function tomorrowISO() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function addDaysISO(dateISO: string, days: number) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const today = todayISO();

// Generalized from the original "Plan Tomorrow" — this page now plans
// *any* date (via ?date=YYYY-MM-DD), defaulting to tomorrow when no date
// is given, so the existing Nav "Plan Tomorrow" link needs no change.
// Today.tsx links here with today's own date via "Adjust today's plan"
// for same-day arrangement, without altering Today's own checkbox UI at
// all — see CLAUDE.md's Phase 14 for the full reasoning, including why
// "Close out today" is gated off when the target date IS today.
function targetDateLabel(dateISO: string) {
  if (dateISO === today) return 'Today';
  if (dateISO === addDaysISO(today, 1)) return 'Tomorrow';
  return dateISO;
}

type PlanItemBase =
  // sectionId here is read directly by groupItemsBySections (habits'
  // fixed home section, see keystone-rules.js) — it's not just along for
  // the ride on `habit`, the grouping function looks at the top-level field.
  | { itemType: 'habit'; itemId: string; sectionId: string; habit: Habit }
  | { itemType: 'task'; itemId: string; task: Task }
  | { itemType: 'class'; itemId: string; klass: Class };

type PlanItem = PlanItemBase & { itemSortOrder: number };

// Inline section rename/reorder/delete — small enough to live at the top
// of Plan rather than a separate settings page, matching where
// arrangement actually happens.
function SectionRow({
  section,
  busy,
  canMoveUp,
  canMoveDown,
  onRename,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  section: DaySection;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onRename: (sectionId: string, name: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(section.name);
  const dirty = name.trim().length > 0 && name.trim() !== section.name;

  return (
    <div className="flex items-center gap-2">
      <Input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} className="flex-1" />
      {dirty && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onRename(section.sectionId, name.trim())}
        >
          Save
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={busy || !canMoveUp} onClick={onMoveUp}>
        ↑
      </Button>
      <Button size="sm" variant="ghost" disabled={busy || !canMoveDown} onClick={onMoveDown}>
        ↓
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onDelete}>
        Delete
      </Button>
    </div>
  );
}

function SectionManager({
  sections,
  busySectionId,
  onAdd,
  onRename,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  sections: DaySection[];
  busySectionId: string | null;
  onAdd: (name: string) => void;
  onRename: (sectionId: string, name: string) => void;
  onMoveUp: (sectionId: string) => void;
  onMoveDown: (sectionId: string) => void;
  onDelete: (sectionId: string) => void;
}) {
  const [newName, setNewName] = useState('');
  const sorted = [...sections].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Day sections</CardTitle>
        <p className="text-sm text-muted-foreground">
          Add, rename, reorder, or remove the sections habits/tasks/classes get grouped into below.
          Deleting a section doesn't delete its items — they fall back to the first remaining section.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {sorted.map((section, i) => (
          <SectionRow
            key={section.sectionId}
            section={section}
            busy={busySectionId === section.sectionId}
            canMoveUp={i > 0}
            canMoveDown={i < sorted.length - 1}
            onRename={onRename}
            onMoveUp={() => onMoveUp(section.sectionId)}
            onMoveDown={() => onMoveDown(section.sectionId)}
            onDelete={() => onDelete(section.sectionId)}
          />
        ))}
        <form
          className="flex gap-2 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newName.trim();
            if (!name) return;
            onAdd(name);
            setNewName('');
          }}
        >
          <Input placeholder="New section name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button type="submit" disabled={busySectionId === 'add'}>
            Add Section
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function Plan() {
  // Re-read on every render (not just once at module scope, unlike the
  // old fixed `tomorrow` constant) so this stays correct across a
  // same-path ?date= change — which is now the normal way of changing
  // dates via the picker below, not just a latent edge case; see the
  // data-loading effect's dependency array, which re-runs whenever this
  // actually changes.
  const navigate = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const requestedDate = params.get('date');
  const requestedPersonIdParam = params.get('personId');
  const targetDate = requestedDate && DATE_PARAM_PATTERN.test(requestedDate) ? requestedDate : tomorrowISO();
  const dateLabel = targetDateLabel(targetDate);
  const isFutureDate = targetDate !== today;

  function goToDate(dateISO: string) {
    const next = new URLSearchParams();
    next.set('date', dateISO);
    if (requestedPersonIdParam) next.set('personId', requestedPersonIdParam);
    navigate(`/plan?${next.toString()}`);
  }

  const [status, setStatus] = useState('Loading…');
  const [writeError, setWriteError] = useState('');
  const [isAuthed, setIsAuthed] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);

  const [currentPerson, setCurrentPerson] = useState<Person | null>(null);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [habitLog, setHabitLog] = useState<HabitLogRow[]>([]);
  const [targetDateLog, setTargetDateLog] = useState<HabitLogRow[]>([]);
  const [expectedClassesForTargetDate, setExpectedClassesForTargetDate] = useState<Class[]>([]);
  const [targetDateClassLog, setTargetDateClassLog] = useState<ClassLogRow[]>([]);
  const [sections, setSections] = useState<DaySection[]>([]);
  const [targetDatePlanItems, setTargetDatePlanItems] = useState<DayPlanItem[]>([]);

  const [taskLabel, setTaskLabel] = useState('');
  const [taskDue, setTaskDue] = useState('');
  const [taskPointValue, setTaskPointValue] = useState('1');
  const [addTaskBusy, setAddTaskBusy] = useState(false);
  const [closeOutBusy, setCloseOutBusy] = useState(false);
  const [busySkipHabitId, setBusySkipHabitId] = useState<string | null>(null);
  const [busySkipClassId, setBusySkipClassId] = useState<string | null>(null);
  const [busySectionId, setBusySectionId] = useState<string | null>(null);

  useEffect(() => {
    const cached = getCachedToken();
    if (cached) {
      provider.setAccessToken(cached);
      setIsAuthed(true);
    }
  }, []);

  useEffect(() => {
    async function run() {
      const requestedPersonId = params.get('personId');

      const people = (await provider.getPeople()) as Person[];
      const person = people.find((p) => p.personId === requestedPersonId) || people[0] || null;
      setCurrentPerson(person);

      if (!person) {
        setStatus('No people found — add one from the Today page first.');
        return;
      }

      const [
        habitsResult,
        tasksResult,
        habitLogResult,
        targetDateLogResult,
        classesResult,
        targetDateClassLogResult,
        sectionsResult,
        targetDatePlanResult,
      ] = (await Promise.all([
        provider.getHabits(person.personId),
        provider.getTasks(person.personId),
        provider.getHabitLog(person.personId, today),
        provider.getHabitLog(person.personId, targetDate),
        provider.getClasses(person.personId),
        provider.getClassLog(person.personId, targetDate),
        provider.getDaySections(person.personId),
        provider.getDayPlan(person.personId, targetDate),
      ])) as [
        Habit[],
        Task[],
        HabitLogRow[],
        HabitLogRow[],
        Class[],
        ClassLogRow[],
        DaySection[],
        DayPlanItem[],
      ];

      setHabits(habitsResult.filter((h) => h.active));
      setTasks(tasksResult);
      setHabitLog(habitLogResult);
      setTargetDateLog(targetDateLogResult);
      setExpectedClassesForTargetDate(getExpectedClassesForDate(classesResult, targetDate) as Class[]);
      setTargetDateClassLog(targetDateClassLogResult);
      setSections(sectionsResult);
      setTargetDatePlanItems(targetDatePlanResult);
      setStatus(`Planning ${dateLabel.toLowerCase()} for ${person.name}`);
    }

    run().catch((err) => {
      setStatus(`Failed to load: ${err.message}`);
      console.error(err);
    });
    // Re-runs if targetDate changes without a full path change (e.g. a
    // future in-app link from one ?date= to another on this same route) —
    // not just on mount, unlike most other pages' effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetDate]);

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

  // Plan-time skip: logs 'skipped' for the target date so the habit
  // doesn't show as actionable on that date's Today, and so close-out's
  // getUnclosedHabits (which is presence-based, see keystone-rules.js)
  // never overwrites it with 'missed' once that date becomes today.
  async function handleSkip(habit: Habit) {
    setBusySkipHabitId(habit.habitId);
    setWriteError('');
    try {
      const row = (await provider.setHabitStatus(targetDate, habit.habitId, 'skipped')) as HabitLogRow;
      setTargetDateLog((rows) => [...rows.filter((r) => r.habitId !== habit.habitId), row]);
    } catch (err) {
      setWriteError(`Failed to skip "${habit.label}": ${(err as Error).message}`);
    } finally {
      setBusySkipHabitId(null);
    }
  }

  // Same plan-time-skip rationale as handleSkip above, for a class instead
  // of a habit. No "mark done"/"reschedule" here — those only make sense
  // once the day actually arrives, so they live on Today, not here.
  async function handleSkipClass(klass: Class) {
    setBusySkipClassId(klass.classId);
    setWriteError('');
    try {
      const row = (await provider.logClassStatus(klass.classId, currentPerson!.personId, targetDate, 'skipped', {
        skippedBy: 'student',
      })) as ClassLogRow;
      setTargetDateClassLog((rows) => [...rows.filter((r) => r.classId !== klass.classId), row]);
    } catch (err) {
      setWriteError(`Failed to skip "${klass.name}": ${(err as Error).message}`);
    } finally {
      setBusySkipClassId(null);
    }
  }

  async function handleAddTask(event: React.FormEvent) {
    event.preventDefault();
    const label = taskLabel.trim();
    if (!label || !currentPerson) return;

    setAddTaskBusy(true);
    setWriteError('');
    try {
      const task = (await provider.addTask(currentPerson.personId, label, taskDue, Number(taskPointValue) || 1)) as Task;
      setTasks((rows) => [...rows, task]);
      setTaskLabel('');
      setTaskDue('');
    } catch (err) {
      setWriteError(`Failed to add task: ${(err as Error).message}`);
    } finally {
      setAddTaskBusy(false);
    }
  }

  // Always closes out literal `today`, regardless of which date is being
  // planned — unchanged from the original "Plan Tomorrow" behavior. Only
  // its visibility is gated (see isFutureDate / the JSX below): showing
  // it while targetDate === today would mean showing "close out the day
  // you're currently mid-way through arranging," which is exactly the
  // premature-finalization risk this page generalizing to same-day use
  // introduced. Not shown when planning today; shown when planning ahead.
  async function handleCloseOut() {
    setCloseOutBusy(true);
    setWriteError('');
    try {
      const unclosed = getUnclosedHabits(habits, habitLog) as Habit[];
      for (const habit of unclosed) {
        const row = (await provider.setHabitStatus(today, habit.habitId, 'missed')) as HabitLogRow;
        setHabitLog((rows) => [...rows, row]);
      }
    } catch (err) {
      setWriteError(`Failed to close out day: ${(err as Error).message}`);
    } finally {
      setCloseOutBusy(false);
    }
  }

  async function handleAddSection(name: string) {
    if (!currentPerson) return;
    setBusySectionId('add');
    setWriteError('');
    try {
      const nextSortOrder = sections.length === 0 ? 0 : Math.max(...sections.map((s) => s.sortOrder)) + 1;
      const section = (await provider.addDaySection(currentPerson.personId, name, nextSortOrder)) as DaySection;
      setSections((rows) => [...rows, section]);
    } catch (err) {
      setWriteError(`Failed to add section: ${(err as Error).message}`);
    } finally {
      setBusySectionId(null);
    }
  }

  async function handleRenameSection(sectionId: string, name: string) {
    const section = sections.find((s) => s.sectionId === sectionId);
    if (!section) return;
    setBusySectionId(sectionId);
    setWriteError('');
    try {
      await provider.updateDaySection(sectionId, { name, sortOrder: section.sortOrder });
      setSections((rows) => rows.map((s) => (s.sectionId === sectionId ? { ...s, name } : s)));
    } catch (err) {
      setWriteError(`Failed to rename section: ${(err as Error).message}`);
    } finally {
      setBusySectionId(null);
    }
  }

  async function handleSwapSections(sectionId: string, direction: 'up' | 'down') {
    const sorted = [...sections].sort((a, b) => a.sortOrder - b.sortOrder);
    const index = sorted.findIndex((s) => s.sectionId === sectionId);
    const neighborIndex = direction === 'up' ? index - 1 : index + 1;
    if (index === -1 || neighborIndex < 0 || neighborIndex >= sorted.length) return;

    const current = sorted[index];
    const neighbor = sorted[neighborIndex];
    setBusySectionId(sectionId);
    setWriteError('');
    try {
      await provider.updateDaySection(current.sectionId, { name: current.name, sortOrder: neighbor.sortOrder });
      await provider.updateDaySection(neighbor.sectionId, { name: neighbor.name, sortOrder: current.sortOrder });
      setSections((rows) =>
        rows.map((s) => {
          if (s.sectionId === current.sectionId) return { ...s, sortOrder: neighbor.sortOrder };
          if (s.sectionId === neighbor.sectionId) return { ...s, sortOrder: current.sortOrder };
          return s;
        })
      );
    } catch (err) {
      setWriteError(`Failed to reorder sections: ${(err as Error).message}`);
    } finally {
      setBusySectionId(null);
    }
  }

  async function handleDeleteSection(sectionId: string) {
    setBusySectionId(sectionId);
    setWriteError('');
    try {
      await provider.deleteDaySection(sectionId);
      setSections((rows) => rows.filter((s) => s.sectionId !== sectionId));
    } catch (err) {
      setWriteError(`Failed to delete section: ${(err as Error).message}`);
    } finally {
      setBusySectionId(null);
    }
  }

  async function handleMove(itemType: PlanItemType, itemId: string, sectionId: string, itemSortOrder: number) {
    if (!currentPerson) return;
    setWriteError('');
    try {
      const row = (await provider.upsertDayPlanItem(
        currentPerson.personId,
        targetDate,
        itemType,
        itemId,
        sectionId,
        itemSortOrder
      )) as DayPlanItem;
      setTargetDatePlanItems((rows) => [
        ...rows.filter((r) => !(r.itemType === itemType && r.itemId === itemId)),
        row,
      ]);
    } catch (err) {
      setWriteError(`Failed to move item: ${(err as Error).message}`);
    }
  }

  const unclosedHabits = getUnclosedHabits(habits, habitLog) as Habit[];
  const openTasks = tasks.filter((task) => task.status === 'pending');

  const planItemsBase: PlanItemBase[] = [
    ...habits.map((habit) => ({ itemType: 'habit' as const, itemId: habit.habitId, sectionId: habit.sectionId, habit })),
    ...openTasks.map((task) => ({ itemType: 'task' as const, itemId: task.taskId, task })),
    ...expectedClassesForTargetDate.map((klass) => ({ itemType: 'class' as const, itemId: klass.classId, klass })),
  ];
  const grouped = useMemo(
    () =>
      groupItemsBySections(planItemsBase, sections, targetDatePlanItems) as {
        section: DaySection;
        items: PlanItem[];
      }[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [habits, openTasks, expectedClassesForTargetDate, sections, targetDatePlanItems]
  );

  function renderPlanItem(item: PlanItem) {
    if (item.itemType === 'habit') {
      const habit = item.habit;
      const status = targetDateLog.find((row) => row.habitId === habit.habitId)?.status ?? null;
      return (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">{habit.label}</span>
          {status === 'skipped' ? (
            <span className="text-xs text-muted-foreground">Skipped for {dateLabel.toLowerCase()}</span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busySkipHabitId === habit.habitId}
              onClick={() => handleSkip(habit)}
            >
              Skip {dateLabel.toLowerCase()}
            </Button>
          )}
        </div>
      );
    }
    if (item.itemType === 'task') {
      const task = item.task;
      const stale = isTaskStale(task, today);
      return (
        <p className="text-sm">
          {task.label}
          {task.dueDate ? ` (due ${task.dueDate})` : ''}
          {stale && <span className="text-destructive"> [stale]</span>}
        </p>
      );
    }
    const klass = item.klass;
    const status = targetDateClassLog.find((row) => row.classId === klass.classId)?.status ?? null;
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">
          {klass.startTime} — {klass.name}
        </span>
        {status === 'skipped' ? (
          <span className="text-xs text-muted-foreground">Skipped for {dateLabel.toLowerCase()}</span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busySkipClassId === klass.classId}
            onClick={() => handleSkipClass(klass)}
          >
            Skip {dateLabel.toLowerCase()}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <Nav personId={currentPerson?.personId ?? null} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Plan {dateLabel}</h1>
          <p className="text-sm text-muted-foreground">{status}</p>
        </div>
        {!isAuthed && (
          <Button onClick={handleSignIn} disabled={signInBusy}>
            Sign in
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="date"
          value={targetDate}
          onChange={(e) => e.target.value && goToDate(e.target.value)}
          className="w-40"
        />
        <Button size="sm" variant="outline" disabled={targetDate === today} onClick={() => goToDate(today)}>
          Today
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={targetDate === tomorrowISO()}
          onClick={() => goToDate(tomorrowISO())}
        >
          Tomorrow
        </Button>
      </div>

      {writeError && <p className="text-sm text-destructive">{writeError}</p>}

      {isAuthed && currentPerson && (
        <>
          <SectionManager
            sections={sections}
            busySectionId={busySectionId}
            onAdd={handleAddSection}
            onRename={handleRenameSection}
            onMoveUp={(sectionId) => handleSwapSections(sectionId, 'up')}
            onMoveDown={(sectionId) => handleSwapSections(sectionId, 'down')}
            onDelete={handleDeleteSection}
          />

          <div>
            <p className="mb-2 text-sm text-muted-foreground">
              {dateLabel}'s habits, classes, and open tasks — drag to arrange, skip a habit/class in advance
              if it doesn't apply. New habits/classes are added from their own pages.
            </p>
            <DayPlanBoard grouped={grouped} onMove={handleMove} renderItem={renderPlanItem} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Add a one-off task</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAddTask} className="flex gap-2">
                <Input
                  placeholder="Task"
                  required
                  value={taskLabel}
                  onChange={(e) => setTaskLabel(e.target.value)}
                />
                <Input type="date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} className="w-40" />
                <Input
                  type="number"
                  min="0"
                  value={taskPointValue}
                  onChange={(e) => setTaskPointValue(e.target.value)}
                  className="w-16"
                  title="Points earned per completion"
                />
                <span className="text-xs text-muted-foreground">pts</span>
                <Button type="submit" disabled={addTaskBusy}>
                  Add Task
                </Button>
              </form>
            </CardContent>
          </Card>

          {isFutureDate && (
            <Card>
              <CardHeader>
                <CardTitle>Close out today</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Only shown while planning ahead — closing out today from a view of today itself, a day
                  still in progress, would finalize it prematurely.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {unclosedHabits.length === 0
                    ? 'Every active habit is already logged for today.'
                    : `${unclosedHabits.length} habit(s) not logged yet today: ${unclosedHabits
                        .map((h) => h.label)
                        .join(', ')}`}
                </p>
                <Button onClick={handleCloseOut} disabled={unclosedHabits.length === 0 || closeOutBusy}>
                  Log missed habits for today
                </Button>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
