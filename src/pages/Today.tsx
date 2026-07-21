import { useEffect, useState } from 'react';
import * as provider from '../lib/provider';
import { isTaskStale, isCheckpointReady, isValidStatusTransition } from '../lib/rules';
import { requestSignIn } from '../lib/auth';
import type { Person, Habit, Task, HabitLogRow, Checkpoint } from '../lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const today = todayISO();

// Old app/*.html pages are still the live version of these until each gets
// its own React port (deleted one at a time, not all at once) — see
// CLAUDE.md. Once a page's React version lands, update every remaining
// nav here (and in the old pages' own nav) to point at the new route.
function Nav({ personId }: { personId: string | null }) {
  const suffix = personId ? `?personId=${personId}` : '';
  const links = [
    { href: `/${suffix}`, label: 'Today' },
    { href: `/app/plan-tomorrow.html${suffix}`, label: 'Plan Tomorrow' },
    { href: `/app/checkpoints.html${suffix}`, label: 'Checkpoints' },
    { href: `/app/report.html${suffix}`, label: 'Report' },
  ];
  return (
    <nav className="flex gap-4 text-sm text-muted-foreground">
      {links.map((link) => (
        <a key={link.label} href={link.href} className="hover:text-foreground hover:underline">
          {link.label}
        </a>
      ))}
    </nav>
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

  const [addPersonName, setAddPersonName] = useState('');
  const [addPersonTheme, setAddPersonTheme] = useState('Playful');
  const [addPersonBusy, setAddPersonBusy] = useState(false);

  const [busyHabitId, setBusyHabitId] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

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

      const [habitsResult, tasksResult, habitLogResult, checkpointsResult] = (await Promise.all([
        provider.getHabits(person.personId),
        provider.getTasks(person.personId),
        provider.getHabitLog(person.personId, today),
        provider.getCheckpoints(person.personId, today),
      ])) as [Habit[], Task[], HabitLogRow[], Checkpoint[]];

      setHabits(habitsResult);
      setTasks(tasksResult);
      setHabitLog(habitLogResult);
      setCheckpoints(checkpointsResult);
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

  async function handleHabitToggle(habit: Habit, checked: boolean, previousStatus: string | null) {
    const toStatus = checked ? 'done' : 'missed';
    if (!isValidStatusTransition('habit', previousStatus, toStatus)) return;

    setBusyHabitId(habit.habitId);
    setWriteError('');
    try {
      await provider.setHabitStatus(today, habit.habitId, toStatus);
      setHabitLog((rows) => [
        ...rows.filter((row) => row.habitId !== habit.habitId),
        { date: today, personId: currentPerson!.personId, habitId: habit.habitId, status: toStatus, checkpointId: '' },
      ]);
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
    } catch (err) {
      setWriteError(`Failed to save "${task.label}": ${(err as Error).message}`);
    } finally {
      setBusyTaskId(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <Nav personId={currentPerson?.personId ?? null} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Today</h1>
          <p className="text-sm text-muted-foreground">{status}</p>
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
          <Card>
            <CardHeader>
              <CardTitle>Habits</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {habits.length === 0 && <p className="text-sm text-muted-foreground">No habits yet.</p>}
              {habits.map((habit) => {
                const logRow = habitLog.find((row) => row.habitId === habit.habitId);
                const habitStatus = logRow ? logRow.status : null;
                return (
                  <div key={habit.habitId} className="flex items-center gap-2">
                    {isAuthed && (
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
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tasks</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {tasks.length === 0 && <p className="text-sm text-muted-foreground">No tasks yet.</p>}
              {tasks.map((task) => {
                const stale = isTaskStale(task, today);
                return (
                  <div key={task.taskId} className="flex items-center gap-2">
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
              })}
            </CardContent>
          </Card>

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
