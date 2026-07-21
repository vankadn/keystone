import { useEffect, useState } from 'react';
import * as provider from '../lib/provider';
import { isCheckpointReady, canGrantReward, resolveOpenRewardChoice } from '../lib/rules';
import { requestSignIn } from '../lib/auth';
import type { Person, Habit, Task, HabitLogRow, Checkpoint, Reward } from '../lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Nav } from '../components/Nav';

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const today = todayISO();

function CheckpointRow({
  checkpoint,
  habitLog,
  tasks,
  rewardCatalog,
  defaultGrantedBy,
  onGrant,
}: {
  checkpoint: Checkpoint;
  habitLog: HabitLogRow[];
  tasks: Task[];
  rewardCatalog: Reward[];
  defaultGrantedBy: string;
  onGrant: (checkpoint: Checkpoint, rewardId: string, grantedBy: string) => void;
}) {
  const [grantedBy, setGrantedBy] = useState(defaultGrantedBy);
  const readyRewards = resolveOpenRewardChoice(rewardCatalog, checkpoint.rewardIds) as Reward[];
  const [openRewardId, setOpenRewardId] = useState(readyRewards[0]?.rewardId ?? '');
  const ready = isCheckpointReady(checkpoint, habitLog, tasks);
  const grantable = canGrantReward(checkpoint);

  return (
    <div className="space-y-2 border-b pb-3 last:border-b-0 last:pb-0">
      <p className="text-sm">
        <strong>{checkpoint.label}</strong> — {checkpoint.status}
        {ready && <span className="text-primary"> [ready to grant]</span>}
      </p>
      {!grantable && <p className="text-sm text-muted-foreground">Already granted.</p>}
      {grantable && checkpoint.rewardMode === 'fixed' && (
        <div className="flex items-center gap-2">
          <Input
            placeholder="Granted by"
            value={grantedBy}
            onChange={(e) => setGrantedBy(e.target.value)}
            className="w-40"
          />
          {readyRewards[0] ? (
            <Button size="sm" onClick={() => onGrant(checkpoint, readyRewards[0].rewardId, grantedBy)}>
              Grant "{readyRewards[0].title}"
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">No reward configured.</p>
          )}
        </div>
      )}
      {grantable && checkpoint.rewardMode === 'open' && (
        <div className="flex items-center gap-2">
          <Input
            placeholder="Granted by"
            value={grantedBy}
            onChange={(e) => setGrantedBy(e.target.value)}
            className="w-40"
          />
          <Select value={openRewardId} onValueChange={(value) => setOpenRewardId(value as string)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {readyRewards.map((r) => (
                <SelectItem key={r.rewardId} value={r.rewardId}>
                  {r.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => onGrant(checkpoint, openRewardId, grantedBy)} disabled={!openRewardId}>
            Grant selected
          </Button>
        </div>
      )}
    </div>
  );
}

function RewardRow({
  reward,
  onSave,
  onDelete,
}: {
  reward: Reward;
  onSave: (rewardId: string, title: string, tags: string[]) => void;
  onDelete: (rewardId: string) => void;
}) {
  const [title, setTitle] = useState(reward.title);
  const [tags, setTags] = useState(reward.tags.join(','));

  return (
    <div className="flex items-center gap-2">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags (comma-separated)" />
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          onSave(
            reward.rewardId,
            title.trim(),
            tags.split(',').map((t) => t.trim()).filter(Boolean)
          )
        }
      >
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onDelete(reward.rewardId)}>
        Delete
      </Button>
    </div>
  );
}

export default function Checkpoints() {
  const [status, setStatus] = useState('Loading…');
  const [writeError, setWriteError] = useState('');
  const [isAuthed, setIsAuthed] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);

  const [currentPerson, setCurrentPerson] = useState<Person | null>(null);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [habitLog, setHabitLog] = useState<HabitLogRow[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [rewardCatalog, setRewardCatalog] = useState<Reward[]>([]);

  const [checkpointLabel, setCheckpointLabel] = useState('');
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [rewardMode, setRewardMode] = useState<'fixed' | 'open'>('fixed');
  const [selectedRewardIds, setSelectedRewardIds] = useState<string[]>([]);
  const [createBusy, setCreateBusy] = useState(false);

  const [rewardTitle, setRewardTitle] = useState('');
  const [rewardTags, setRewardTags] = useState('');
  const [addRewardBusy, setAddRewardBusy] = useState(false);

  async function reloadCheckpoints(personId: string) {
    setCheckpoints((await provider.getCheckpoints(personId, today)) as Checkpoint[]);
  }

  async function reloadRewardCatalog(personId: string) {
    setRewardCatalog((await provider.getRewardCatalog(personId)) as Reward[]);
  }

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

      const [habitsResult, tasksResult, habitLogResult, checkpointsResult, rewardCatalogResult] = (await Promise.all([
        provider.getHabits(person.personId),
        provider.getTasks(person.personId),
        provider.getHabitLog(person.personId, today),
        provider.getCheckpoints(person.personId, today),
        provider.getRewardCatalog(person.personId),
      ])) as [Habit[], Task[], HabitLogRow[], Checkpoint[], Reward[]];

      setHabits(habitsResult);
      setTasks(tasksResult);
      setHabitLog(habitLogResult);
      setCheckpoints(checkpointsResult);
      setRewardCatalog(rewardCatalogResult);
      setStatus(`Checkpoints for ${person.name}`);
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

  function toggleItemId(id: string, checked: boolean) {
    setSelectedItemIds((ids) => (checked ? [...ids, id] : ids.filter((existing) => existing !== id)));
  }

  function toggleRewardId(id: string, checked: boolean) {
    setSelectedRewardIds((ids) => (checked ? [...ids, id] : ids.filter((existing) => existing !== id)));
  }

  async function handleCreateCheckpoint(event: React.FormEvent) {
    event.preventDefault();
    if (!currentPerson) return;
    const label = checkpointLabel.trim();
    if (!label || selectedItemIds.length === 0 || selectedRewardIds.length === 0) {
      setWriteError('Label, at least one item, and at least one reward are required.');
      return;
    }

    setCreateBusy(true);
    setWriteError('');
    try {
      await provider.upsertCheckpoint({
        date: today,
        personId: currentPerson.personId,
        label,
        itemIds: selectedItemIds,
        rewardMode,
        rewardIds: selectedRewardIds,
        status: 'pending',
      });
      setCheckpointLabel('');
      setSelectedItemIds([]);
      setSelectedRewardIds([]);
      await reloadCheckpoints(currentPerson.personId);
    } catch (err) {
      setWriteError(`Failed to create checkpoint: ${(err as Error).message}`);
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleAddReward(event: React.FormEvent) {
    event.preventDefault();
    if (!currentPerson) return;
    const title = rewardTitle.trim();
    if (!title) return;

    setAddRewardBusy(true);
    setWriteError('');
    try {
      const tags = rewardTags.split(',').map((t) => t.trim()).filter(Boolean);
      await provider.addReward(currentPerson.personId, title, tags);
      setRewardTitle('');
      setRewardTags('');
      await reloadRewardCatalog(currentPerson.personId);
    } catch (err) {
      setWriteError(`Failed to add reward: ${(err as Error).message}`);
    } finally {
      setAddRewardBusy(false);
    }
  }

  async function handleSaveReward(rewardId: string, title: string, tags: string[]) {
    if (!currentPerson) return;
    setWriteError('');
    try {
      await provider.updateReward(rewardId, title, tags);
      await reloadRewardCatalog(currentPerson.personId);
    } catch (err) {
      setWriteError(`Failed to update reward: ${(err as Error).message}`);
    }
  }

  async function handleDeleteReward(rewardId: string) {
    if (!currentPerson) return;
    setWriteError('');
    try {
      await provider.deleteReward(rewardId);
      await reloadRewardCatalog(currentPerson.personId);
    } catch (err) {
      setWriteError(`Failed to delete reward: ${(err as Error).message}`);
    }
  }

  async function handleGrant(checkpoint: Checkpoint, rewardId: string, grantedBy: string) {
    if (!currentPerson) return;
    setWriteError('');
    try {
      await provider.grantReward(checkpoint.checkpointId, rewardId, grantedBy || currentPerson.name);
      await reloadCheckpoints(currentPerson.personId);
    } catch (err) {
      setWriteError(`Failed to grant reward: ${(err as Error).message}`);
    }
  }

  const openTasks = tasks.filter((t) => t.status === 'pending');

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <Nav personId={currentPerson?.personId ?? null} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Checkpoints</h1>
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
              <CardTitle>Today's checkpoints</CardTitle>
            </CardHeader>
            <CardContent>
              {checkpoints.length === 0 && <p className="text-sm text-muted-foreground">No checkpoints yet today.</p>}
              {checkpoints.length > 0 && (
                <div className="space-y-3">
                  {checkpoints.map((checkpoint) => (
                    <CheckpointRow
                      key={checkpoint.checkpointId}
                      checkpoint={checkpoint}
                      habitLog={habitLog}
                      tasks={tasks}
                      rewardCatalog={rewardCatalog}
                      defaultGrantedBy={currentPerson.name}
                      onGrant={handleGrant}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Create a checkpoint</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreateCheckpoint} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="checkpoint-label">Label</Label>
                  <Input
                    id="checkpoint-label"
                    required
                    value={checkpointLabel}
                    onChange={(e) => setCheckpointLabel(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Items (today's habits &amp; open tasks)</Label>
                  {habits.length === 0 && openTasks.length === 0 && (
                    <p className="text-sm text-muted-foreground">Nothing to group yet.</p>
                  )}
                  {habits.map((habit) => (
                    <div key={habit.habitId} className="flex items-center gap-2">
                      <Checkbox
                        checked={selectedItemIds.includes(habit.habitId)}
                        onCheckedChange={(checked) => toggleItemId(habit.habitId, checked === true)}
                      />
                      <span className="text-sm">{habit.label} (habit)</span>
                    </div>
                  ))}
                  {openTasks.map((task) => (
                    <div key={task.taskId} className="flex items-center gap-2">
                      <Checkbox
                        checked={selectedItemIds.includes(task.taskId)}
                        onCheckedChange={(checked) => toggleItemId(task.taskId, checked === true)}
                      />
                      <span className="text-sm">{task.label} (task)</span>
                    </div>
                  ))}
                </div>

                <div className="space-y-2">
                  <Label>Reward mode</Label>
                  <Select
                    value={rewardMode}
                    onValueChange={(value) => {
                      setRewardMode(value as 'fixed' | 'open');
                      setSelectedRewardIds([]);
                    }}
                  >
                    <SelectTrigger className="w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixed">Fixed</SelectItem>
                      <SelectItem value="open">Open (pick from pool)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Reward(s) — single pick for fixed, multi-pick for open</Label>
                  {rewardCatalog.length === 0 && (
                    <p className="text-sm text-muted-foreground">Add a reward to the catalog first.</p>
                  )}
                  {rewardMode === 'fixed' ? (
                    <Select
                      value={selectedRewardIds[0] ?? ''}
                      onValueChange={(value) => setSelectedRewardIds(value ? [value as string] : [])}
                    >
                      <SelectTrigger className="w-64">
                        <SelectValue placeholder="Choose a reward" />
                      </SelectTrigger>
                      <SelectContent>
                        {rewardCatalog.map((r) => (
                          <SelectItem key={r.rewardId} value={r.rewardId}>
                            {r.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    rewardCatalog.map((r) => (
                      <div key={r.rewardId} className="flex items-center gap-2">
                        <Checkbox
                          checked={selectedRewardIds.includes(r.rewardId)}
                          onCheckedChange={(checked) => toggleRewardId(r.rewardId, checked === true)}
                        />
                        <span className="text-sm">{r.title}</span>
                      </div>
                    ))
                  )}
                </div>

                <Button type="submit" disabled={createBusy}>
                  Create Checkpoint
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Reward catalog</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                {rewardCatalog.map((reward) => (
                  <RewardRow
                    key={reward.rewardId}
                    reward={reward}
                    onSave={handleSaveReward}
                    onDelete={handleDeleteReward}
                  />
                ))}
              </div>
              <form onSubmit={handleAddReward} className="flex gap-2">
                <Input
                  placeholder="Reward title"
                  required
                  value={rewardTitle}
                  onChange={(e) => setRewardTitle(e.target.value)}
                />
                <Input
                  placeholder="tags (comma-separated)"
                  value={rewardTags}
                  onChange={(e) => setRewardTags(e.target.value)}
                />
                <Button type="submit" disabled={addRewardBusy}>
                  Add Reward
                </Button>
              </form>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
