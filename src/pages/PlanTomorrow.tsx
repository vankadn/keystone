import { useEffect, useState } from 'react';
import * as provider from '../lib/provider';
import { isTaskStale, getUnclosedHabits } from '../lib/rules';
import { requestSignIn } from '../lib/auth';
import type { Person, Habit, Task, HabitLogRow } from '../lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Nav } from '../components/Nav';

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const today = todayISO();

export default function PlanTomorrow() {
  const [status, setStatus] = useState('Loading…');
  const [writeError, setWriteError] = useState('');
  const [isAuthed, setIsAuthed] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);

  const [currentPerson, setCurrentPerson] = useState<Person | null>(null);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [habitLog, setHabitLog] = useState<HabitLogRow[]>([]);

  const [taskLabel, setTaskLabel] = useState('');
  const [taskDue, setTaskDue] = useState('');
  const [addTaskBusy, setAddTaskBusy] = useState(false);
  const [closeOutBusy, setCloseOutBusy] = useState(false);

  useEffect(() => {
    async function run() {
      const params = new URLSearchParams(window.location.search);
      const requestedPersonId = params.get('personId');

      const people = (await provider.getPeople()) as Person[];
      const person = people.find((p) => p.personId === requestedPersonId) || people[0] || null;
      setCurrentPerson(person);

      if (!person) {
        setStatus('No people found — add one from the Today page first.');
        return;
      }

      const [habitsResult, tasksResult, habitLogResult] = (await Promise.all([
        provider.getHabits(person.personId),
        provider.getTasks(person.personId),
        provider.getHabitLog(person.personId, today),
      ])) as [Habit[], Task[], HabitLogRow[]];

      setHabits(habitsResult);
      setTasks(tasksResult);
      setHabitLog(habitLogResult);
      setStatus(`Planning for ${person.name}`);
    }

    run().catch((err) => {
      setStatus(`Failed to load: ${err.message}`);
      console.error(err);
    });
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

  async function handleAddTask(event: React.FormEvent) {
    event.preventDefault();
    const label = taskLabel.trim();
    if (!label || !currentPerson) return;

    setAddTaskBusy(true);
    setWriteError('');
    try {
      const task = (await provider.addTask(currentPerson.personId, label, taskDue)) as Task;
      setTasks((rows) => [...rows, task]);
      setTaskLabel('');
      setTaskDue('');
    } catch (err) {
      setWriteError(`Failed to add task: ${(err as Error).message}`);
    } finally {
      setAddTaskBusy(false);
    }
  }

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

  const unclosedHabits = getUnclosedHabits(habits, habitLog) as Habit[];
  const openTasks = tasks.filter((task) => task.status === 'pending');

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <Nav personId={currentPerson?.personId ?? null} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Plan Tomorrow</h1>
          <p className="text-sm text-muted-foreground">{status}</p>
        </div>
        {!isAuthed && (
          <Button onClick={handleSignIn} disabled={signInBusy}>
            Sign in
          </Button>
        )}
      </div>

      {writeError && <p className="text-sm text-destructive">{writeError}</p>}

      {isAuthed && currentPerson && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Recurring habits</CardTitle>
              <p className="text-sm text-muted-foreground">
                Read-only preview of what's active — per-day habit toggling isn't built yet.
              </p>
            </CardHeader>
            <CardContent className="space-y-1">
              {habits.length === 0 && <p className="text-sm text-muted-foreground">No habits yet.</p>}
              {habits.map((habit) => (
                <p key={habit.habitId} className="text-sm">
                  {habit.label}
                </p>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Open tasks</CardTitle>
              <p className="text-sm text-muted-foreground">
                Carries forward automatically — nothing to do here unless it's stale.
              </p>
            </CardHeader>
            <CardContent className="space-y-1">
              {openTasks.length === 0 && <p className="text-sm text-muted-foreground">No open tasks.</p>}
              {openTasks.map((task) => {
                const stale = isTaskStale(task, today);
                return (
                  <p key={task.taskId} className="text-sm">
                    {task.label}
                    {task.dueDate ? ` (due ${task.dueDate})` : ''}
                    {stale && <span className="text-destructive"> [stale]</span>}
                  </p>
                );
              })}
            </CardContent>
          </Card>

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
                <Button type="submit" disabled={addTaskBusy}>
                  Add Task
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Close out today</CardTitle>
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
        </>
      )}
    </div>
  );
}
