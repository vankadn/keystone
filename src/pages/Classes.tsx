import { useEffect, useState } from 'react';
import * as provider from '../lib/provider';
import { DAYS_OF_WEEK } from '../lib/rules';
import { requestSignIn, getCachedToken } from '../lib/auth';
import type { Person, Class } from '../lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Nav } from '../components/Nav';

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function DayPicker({
  selected,
  onChange,
  disabled,
}: {
  selected: string[];
  onChange: (days: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {DAYS_OF_WEEK.map((day) => {
        const on = selected.includes(day);
        return (
          <Button
            key={day}
            type="button"
            size="sm"
            variant={on ? 'default' : 'outline'}
            disabled={disabled}
            onClick={() => onChange(on ? selected.filter((d) => d !== day) : [...selected, day])}
          >
            {day}
          </Button>
        );
      })}
    </div>
  );
}

function ClassRow({
  klass,
  busy,
  onSave,
  onToggleActive,
}: {
  klass: Class;
  busy: boolean;
  onSave: (classId: string, fields: { name: string; daysOfWeek: string[]; startTime: string; durationMinutes: number }) => void;
  onToggleActive: (classId: string, active: boolean) => void;
}) {
  const [name, setName] = useState(klass.name);
  const [daysOfWeek, setDaysOfWeek] = useState<string[]>(klass.daysOfWeek);
  const [startTime, setStartTime] = useState(klass.startTime);
  const [durationMinutes, setDurationMinutes] = useState(String(klass.durationMinutes));

  const dirty =
    name.trim() !== klass.name ||
    daysOfWeek.join(',') !== klass.daysOfWeek.join(',') ||
    startTime !== klass.startTime ||
    Number(durationMinutes) !== klass.durationMinutes;

  return (
    <div className="space-y-2 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="flex items-center gap-2">
        <Checkbox
          checked={klass.active}
          disabled={busy}
          onCheckedChange={(checked) => onToggleActive(klass.classId, checked as boolean)}
        />
        <Input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} className="flex-1" />
        {!klass.active && <span className="text-xs text-muted-foreground">inactive</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-6">
        <DayPicker selected={daysOfWeek} onChange={setDaysOfWeek} disabled={busy} />
        <Input
          type="time"
          value={startTime}
          disabled={busy}
          onChange={(e) => setStartTime(e.target.value)}
          className="w-28"
        />
        <Input
          type="number"
          min="0"
          value={durationMinutes}
          disabled={busy}
          onChange={(e) => setDurationMinutes(e.target.value)}
          className="w-20"
        />
        <span className="text-xs text-muted-foreground">min</span>
        {dirty && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !name.trim()}
            onClick={() =>
              onSave(klass.classId, {
                name: name.trim(),
                daysOfWeek,
                startTime,
                durationMinutes: Number(durationMinutes) || 0,
              })
            }
          >
            Save
          </Button>
        )}
      </div>
    </div>
  );
}

// Classes are created/edited/deactivated here only — Today and Plan
// Tomorrow just render whatever's expected on a given date, no add-class
// UI in either. Distinct entity from Habits (see CLAUDE.md's Classes
// phase): weekday+time-bound, not daily-reset.
export default function Classes() {
  const [status, setStatus] = useState('Loading…');
  const [writeError, setWriteError] = useState('');
  const [isAuthed, setIsAuthed] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);

  const [currentPerson, setCurrentPerson] = useState<Person | null>(null);
  const [classes, setClasses] = useState<Class[]>([]);
  const [busyClassId, setBusyClassId] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newDays, setNewDays] = useState<string[]>([]);
  const [newStartTime, setNewStartTime] = useState('');
  const [newDuration, setNewDuration] = useState('30');
  const [addBusy, setAddBusy] = useState(false);

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

      if (!person) {
        setStatus('No people found — add one from the Today page first.');
        return;
      }

      const classesResult = (await provider.getClasses(person.personId)) as Class[];
      setClasses(classesResult);
      setStatus(`Classes for ${person.name}`);
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

  async function handleAddClass(event: React.FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || !currentPerson || newDays.length === 0) return;

    setAddBusy(true);
    setWriteError('');
    try {
      const klass = (await provider.addClass(
        currentPerson.personId,
        name,
        newDays,
        newStartTime,
        Number(newDuration) || 0
      )) as Class;
      setClasses((rows) => [...rows, klass]);
      setNewName('');
      setNewDays([]);
      setNewStartTime('');
      setNewDuration('30');
    } catch (err) {
      setWriteError(`Failed to add class: ${(err as Error).message}`);
    } finally {
      setAddBusy(false);
    }
  }

  async function handleSave(
    classId: string,
    fields: { name: string; daysOfWeek: string[]; startTime: string; durationMinutes: number }
  ) {
    setBusyClassId(classId);
    setWriteError('');
    try {
      await provider.updateClass(classId, fields);
      setClasses((rows) => (rows as Class[]).map((c) => (c.classId === classId ? { ...c, ...fields } : c)));
    } catch (err) {
      setWriteError(`Failed to update class: ${(err as Error).message}`);
    } finally {
      setBusyClassId(null);
    }
  }

  async function handleToggleActive(classId: string, active: boolean) {
    setBusyClassId(classId);
    setWriteError('');
    try {
      await provider.setClassActive(classId, active);
      setClasses((rows) => rows.map((c) => (c.classId === classId ? { ...c, active } : c)));
    } catch (err) {
      setWriteError(`Failed to update class: ${(err as Error).message}`);
    } finally {
      setBusyClassId(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <Nav personId={currentPerson?.personId ?? null} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Classes</h1>
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
              <CardTitle>Add a class</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAddClass} className="space-y-2">
                <Input
                  placeholder="Class name"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Days</Label>
                  <DayPicker selected={newDays} onChange={setNewDays} />
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="time"
                    value={newStartTime}
                    onChange={(e) => setNewStartTime(e.target.value)}
                    className="w-28"
                  />
                  <Input
                    type="number"
                    min="0"
                    value={newDuration}
                    onChange={(e) => setNewDuration(e.target.value)}
                    className="w-20"
                  />
                  <span className="text-xs text-muted-foreground">min</span>
                  <Button type="submit" disabled={addBusy || newDays.length === 0}>
                    Add Class
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>All classes</CardTitle>
              <p className="text-sm text-muted-foreground">
                Uncheck to deactivate — hides it from Today/Plan Tomorrow without touching its history.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {classes.length === 0 && <p className="text-sm text-muted-foreground">No classes yet.</p>}
              {classes.map((klass) => (
                <ClassRow
                  key={klass.classId}
                  klass={klass}
                  busy={busyClassId === klass.classId}
                  onSave={handleSave}
                  onToggleActive={handleToggleActive}
                />
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
