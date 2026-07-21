import { useEffect, useState } from 'react';
import * as provider from '../lib/provider';
import { isTaskStale, isCheckpointReady, isValidStatusTransition } from '../lib/rules';
import { requestSilentToken, requestSignIn } from '../lib/auth';
import type { Person, Habit, Task, HabitLogRow, Checkpoint } from '../lib/types';

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
  return (
    <nav>
      <a href={`/${suffix}`}>Today</a> |{' '}
      <a href={`/app/plan-tomorrow.html${suffix}`}>Plan Tomorrow</a> |{' '}
      <a href={`/app/checkpoints.html${suffix}`}>Checkpoints</a> |{' '}
      <a href={`/app/report.html${suffix}`}>Report</a>
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

  async function trySilentSignIn() {
    try {
      const token = await requestSilentToken(window.KEYSTONE_CONFIG.oauthClientId, OAUTH_SCOPE);
      if (token) {
        provider.setAccessToken(token);
        setIsAuthed(true);
      }
    } catch (err) {
      console.warn('Silent sign-in failed, falling back to sign-in button.', err);
    }
  }

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
        await trySilentSignIn();
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

      await trySilentSignIn();
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
    <div>
      <Nav personId={currentPerson?.personId ?? null} />
      <h1>Today</h1>
      <p>{status}</p>
      {!isAuthed && (
        <button onClick={handleSignIn} disabled={signInBusy}>
          Sign in
        </button>
      )}
      {writeError && <p style={{ color: '#b00020' }}>{writeError}</p>}

      {peopleChecked && !currentPerson && isAuthed && (
        <section>
          <h2>Add Person</h2>
          <form onSubmit={handleAddPerson}>
            <input
              type="text"
              placeholder="Name"
              required
              value={addPersonName}
              onChange={(e) => setAddPersonName(e.target.value)}
            />
            <select value={addPersonTheme} onChange={(e) => setAddPersonTheme(e.target.value)}>
              <option value="Playful">Playful</option>
              <option value="Minimal">Minimal</option>
              <option value="Warm">Warm</option>
            </select>
            <button type="submit" disabled={addPersonBusy}>
              Add Person
            </button>
          </form>
        </section>
      )}

      {currentPerson && (
        <>
          <section>
            <h2>Habits</h2>
            {habits.map((habit) => {
              const logRow = habitLog.find((row) => row.habitId === habit.habitId);
              const habitStatus = logRow ? logRow.status : null;
              return (
                <div key={habit.habitId}>
                  {isAuthed ? (
                    <input
                      type="checkbox"
                      checked={habitStatus === 'done'}
                      disabled={busyHabitId === habit.habitId}
                      onChange={(e) => handleHabitToggle(habit, e.target.checked, habitStatus)}
                    />
                  ) : null}
                  {` ${habit.label} — ${habitStatus || 'not logged'}`}
                </div>
              );
            })}
          </section>

          <section>
            <h2>Tasks</h2>
            {tasks.map((task) => {
              const stale = isTaskStale(task, today) ? ' [stale]' : '';
              return (
                <div key={task.taskId}>
                  {isAuthed ? (
                    <input
                      type="checkbox"
                      checked={task.status === 'done'}
                      disabled={busyTaskId === task.taskId}
                      onChange={(e) => handleTaskToggle(task, e.target.checked)}
                    />
                  ) : null}
                  {` ${task.label} — ${task.status}${stale}`}
                </div>
              );
            })}
          </section>

          <section>
            <h2>Checkpoints</h2>
            {checkpoints.map((checkpoint) => {
              const ready = isCheckpointReady(checkpoint, habitLog, tasks) ? ' [ready to grant]' : '';
              return (
                <div key={checkpoint.checkpointId}>
                  {checkpoint.label} — {checkpoint.status}
                  {ready}
                </div>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}
