import { useEffect, useState } from 'react';
import * as provider from '../lib/provider';
import { requestSignIn, getCachedToken } from '../lib/auth';
import type { Person, Habit, DaySection } from '../lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Nav } from '../components/Nav';

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// A habit's section is its fixed home (Phase 11 amendment) — unlike Tasks/
// Classes, which are freely reassignable per day on Today/Plan Tomorrow,
// a habit's section is a property of the habit definition itself, set
// here. See CLAUDE.md's Data model section for the full reasoning.
function HabitRow({
  habit,
  sections,
  busy,
  onSave,
  onToggleActive,
}: {
  habit: Habit;
  sections: DaySection[];
  busy: boolean;
  onSave: (habitId: string, fields: { label: string; sectionId: string; pointValue: number }) => void;
  onToggleActive: (habitId: string, active: boolean) => void;
}) {
  const [label, setLabel] = useState(habit.label);
  const [sectionId, setSectionId] = useState(habit.sectionId);
  const [pointValue, setPointValue] = useState(String(habit.pointValue));
  const dirty =
    (label.trim().length > 0 && label.trim() !== habit.label) ||
    sectionId !== habit.sectionId ||
    Number(pointValue) !== habit.pointValue;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b pb-2 last:border-b-0 last:pb-0">
      <Checkbox
        checked={habit.active}
        disabled={busy}
        onCheckedChange={(checked) => onToggleActive(habit.habitId, checked as boolean)}
      />
      <Input value={label} disabled={busy} onChange={(e) => setLabel(e.target.value)} className="flex-1" />
      <Select value={sectionId} onValueChange={(value) => setSectionId(value as string)} disabled={busy}>
        <SelectTrigger className="w-36">
          <SelectValue placeholder="Section" />
        </SelectTrigger>
        <SelectContent>
          {sections.map((section) => (
            <SelectItem key={section.sectionId} value={section.sectionId}>
              {section.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        type="number"
        min="0"
        value={pointValue}
        disabled={busy}
        onChange={(e) => setPointValue(e.target.value)}
        className="w-16"
        title="Points earned per completion"
      />
      <span className="text-xs text-muted-foreground">pts</span>
      {dirty && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !label.trim()}
          onClick={() => onSave(habit.habitId, { label: label.trim(), sectionId, pointValue: Number(pointValue) || 1 })}
        >
          Save
        </Button>
      )}
      {!habit.active && <span className="text-xs text-muted-foreground">inactive</span>}
    </div>
  );
}

// Habits are created/edited/deactivated here only — Today and Plan
// Tomorrow just render whatever's active, no add-habit UI in either.
export default function Habits() {
  const [status, setStatus] = useState('Loading…');
  const [writeError, setWriteError] = useState('');
  const [isAuthed, setIsAuthed] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);

  const [currentPerson, setCurrentPerson] = useState<Person | null>(null);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [sections, setSections] = useState<DaySection[]>([]);
  const [busyHabitId, setBusyHabitId] = useState<string | null>(null);

  const [newHabitLabel, setNewHabitLabel] = useState('');
  const [newHabitSectionId, setNewHabitSectionId] = useState('');
  const [newHabitPointValue, setNewHabitPointValue] = useState('1');
  const [addHabitBusy, setAddHabitBusy] = useState(false);

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

      const [habitsResult, sectionsResult] = (await Promise.all([
        provider.getHabits(person.personId),
        provider.getDaySections(person.personId),
      ])) as [Habit[], DaySection[]];
      setHabits(habitsResult);
      setSections(sectionsResult);
      setNewHabitSectionId((current) => current || [...sectionsResult].sort((a, b) => a.sortOrder - b.sortOrder)[0]?.sectionId || '');
      setStatus(`Habits for ${person.name}`);
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

  async function handleAddHabit(event: React.FormEvent) {
    event.preventDefault();
    const label = newHabitLabel.trim();
    if (!label || !currentPerson || !newHabitSectionId) return;

    setAddHabitBusy(true);
    setWriteError('');
    try {
      const habit = (await provider.addHabit(
        currentPerson.personId,
        label,
        newHabitSectionId,
        Number(newHabitPointValue) || 1
      )) as Habit;
      setHabits((rows) => [...rows, habit]);
      setNewHabitLabel('');
    } catch (err) {
      setWriteError(`Failed to add habit: ${(err as Error).message}`);
    } finally {
      setAddHabitBusy(false);
    }
  }

  async function handleSaveHabit(habitId: string, fields: { label: string; sectionId: string; pointValue: number }) {
    setBusyHabitId(habitId);
    setWriteError('');
    try {
      await provider.updateHabit(habitId, fields);
      setHabits((rows) => rows.map((h) => (h.habitId === habitId ? { ...h, ...fields } : h)));
    } catch (err) {
      setWriteError(`Failed to update habit: ${(err as Error).message}`);
    } finally {
      setBusyHabitId(null);
    }
  }

  async function handleToggleActive(habitId: string, active: boolean) {
    setBusyHabitId(habitId);
    setWriteError('');
    try {
      await provider.setHabitActive(habitId, active);
      setHabits((rows) => rows.map((h) => (h.habitId === habitId ? { ...h, active } : h)));
    } catch (err) {
      setWriteError(`Failed to update habit: ${(err as Error).message}`);
    } finally {
      setBusyHabitId(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <Nav personId={currentPerson?.personId ?? null} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Habits</h1>
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
              <CardTitle>Add a habit</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAddHabit} className="flex gap-2">
                <Input
                  placeholder="Habit name"
                  required
                  value={newHabitLabel}
                  onChange={(e) => setNewHabitLabel(e.target.value)}
                />
                <Select value={newHabitSectionId} onValueChange={(value) => setNewHabitSectionId(value as string)}>
                  <SelectTrigger className="w-36">
                    <SelectValue placeholder="Section" />
                  </SelectTrigger>
                  <SelectContent>
                    {sections.map((section) => (
                      <SelectItem key={section.sectionId} value={section.sectionId}>
                        {section.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min="0"
                  value={newHabitPointValue}
                  onChange={(e) => setNewHabitPointValue(e.target.value)}
                  className="w-16"
                  title="Points earned per completion"
                />
                <span className="text-xs text-muted-foreground">pts</span>
                <Button type="submit" disabled={addHabitBusy || !newHabitSectionId}>
                  Add Habit
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>All habits</CardTitle>
              <p className="text-sm text-muted-foreground">
                Uncheck to deactivate — hides it from Today/Plan Tomorrow without touching its history.
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {habits.length === 0 && <p className="text-sm text-muted-foreground">No habits yet.</p>}
              {habits.map((habit) => (
                <HabitRow
                  key={habit.habitId}
                  habit={habit}
                  sections={sections}
                  busy={busyHabitId === habit.habitId}
                  onSave={handleSaveHabit}
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
