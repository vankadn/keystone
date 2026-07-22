// Keystone data provider — data layer only. Knows how to fetch/store rows
// matching the Sheet schema; contains no business logic (it never decides
// what "complete" or "stale" means — that's keystone-rules.js).
//
// SHEET_SCHEMA below is the single source of truth for tab/column
// structure — initializeSheet() reads from it. Sheet structure is always
// app-initialized, never hand-edited.
//
// Reads are wired to the real Sheets API (anon, via API key). All OAuth
// writes read their token from a module-level variable set via
// setAccessToken() — this keeps their own signatures unchanged from the
// Phase 1 mock contract; sign-in/token-refresh orchestration lives in
// keystone-auth.js and the src/pages/*.tsx components, never here.

export const SHEET_SCHEMA = {
  people: ['personId', 'name', 'theme', 'avatar'],
  habits: ['habitId', 'personId', 'label', 'active', 'sectionId'],
  tasks: ['taskId', 'personId', 'label', 'createdDate', 'dueDate', 'status', 'lastCarriedDate'],
  habit_log: ['date', 'personId', 'habitId', 'status', 'checkpointId'],
  checkpoints: ['date', 'personId', 'checkpointId', 'label', 'itemIds', 'rewardMode', 'rewardIds', 'status'],
  reward_catalog: ['rewardId', 'personId', 'title', 'tags'],
  weekly_rules: ['personId', 'metric', 'rewardId'],
  reward_log: ['date', 'personId', 'checkpointIdOrWeekId', 'rewardChosen', 'grantedBy', 'status'],
  classes: ['classId', 'personId', 'name', 'daysOfWeek', 'startTime', 'durationMinutes', 'active'],
  class_log: ['classId', 'personId', 'date', 'status', 'rescheduledTo', 'skippedBy'],
  day_sections: ['sectionId', 'personId', 'name', 'sortOrder'],
  day_plan_items: ['personId', 'date', 'itemType', 'itemId', 'sectionId', 'itemSortOrder'],
};

// Seed data only — nothing in the domain/provider logic assumes exactly
// 3 sections; the user can add/rename/reorder/delete beyond these later
// (see addDaySection/updateDaySection/deleteDaySection below).
const DEFAULT_DAY_SECTIONS = ['Morning', 'Afternoon', 'Evening'];

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// Template Sheet for local dev/testing — already created, tabs not yet
// initialized (run the /setup route against it). Bring-your-own-sheet
// users override via ?sheetId= or .env.local's VITE_SHEET_ID.
const DEFAULT_SHEET_ID = '1kEWgsvtnpy4bVQDgBpdiplpuNGVRWNyty6ckMJvI8kk';
const SHEET_ID_STORAGE_KEY = 'keystone.sheetId';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function getApiKey() {
  return (window.KEYSTONE_CONFIG && window.KEYSTONE_CONFIG.apiKey) || '';
}

let currentAccessToken = null;

// UI calls this once it has a token (silent or explicit sign-in). Keeps
// setHabitStatus/setTaskStatus's own signatures identical to their Phase 1
// mock form — no token param threaded through every call site.
export function setAccessToken(token) {
  currentAccessToken = token;
}

export function clearAccessToken() {
  currentAccessToken = null;
}

function requireAccessToken() {
  if (!currentAccessToken) {
    throw new Error('No access token set — sign in required for writes.');
  }
  return currentAccessToken;
}

function parseBoolean(value) {
  return String(value).trim().toUpperCase() === 'TRUE';
}

function parseList(value) {
  if (!value) return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

// Row-array -> objects keyed by the header row (row 0). An empty/header-only
// tab (template Sheet with no data rows yet) resolves to [], not an error.
function rowsToObjects(rows) {
  if (!rows || rows.length === 0) return [];
  const [header, ...dataRows] = rows;
  return dataRows.map((row) =>
    header.reduce((obj, col, i) => {
      obj[col] = row[i] !== undefined ? row[i] : '';
      return obj;
    }, {})
  );
}

// Coalesces every fetchRawRows() call issued within the same microtask tick
// (e.g. a page's Promise.all([getPeople(), getHabits(), ...])) into one
// spreadsheets.values.batchGet request instead of N separate
// spreadsheets.values.get calls. Sheets' anonymous-read quota
// ("Read requests per minute per user", 60/min) counts each HTTP call once
// no matter how many ranges batchGet carries, so this cuts real request
// volume roughly by the tab count per page load — added after hitting a
// 429 RESOURCE_EXHAUSTED during ordinary manual testing (nav between a
// couple pages was enough to add up). Relies on the standard
// microtask-queue-drains-before-next-task guarantee: every fetchRawRows()
// call fired synchronously (i.e. inside the same Promise.all literal)
// registers its tab into `batch.tabs` before the queueMicrotask callback
// that flushes the batch gets to run.
let pendingBatch = null;

function flushBatch(batch) {
  if (pendingBatch === batch) pendingBatch = null;
  (async () => {
    try {
      const sheetId = await getSheetId();
      const apiKey = getApiKey();
      const tabs = [...batch.tabs];
      const ranges = tabs.map((tab) => `ranges=${encodeURIComponent(`${tab}!A:Z`)}`).join('&');
      const url = `${SHEETS_API_BASE}/${sheetId}/values:batchGet?${ranges}&key=${apiKey}`;
      const response = await fetch(url);
      if (!response.ok) {
        // response.statusText is often blank for these anon GETs, unlike
        // the OAuth write path below — use the response body instead so
        // this doesn't just say ": 400" with no diagnosable detail (e.g.
        // "Unable to parse range" when a tab hasn't been created yet via
        // /setup's Initialize Sheet).
        const body = await response.text();
        throw new Error(`Failed to fetch [${tabs.join(', ')}]: ${response.status} ${body}`);
      }
      const data = await response.json();
      const valueRanges = data.valueRanges || [];
      const rowsByTab = new Map(tabs.map((tab, i) => [tab, (valueRanges[i] && valueRanges[i].values) || []]));
      batch.resolve(rowsByTab);
    } catch (err) {
      batch.reject(err);
    }
  })();
}

function fetchRawRows(tab) {
  if (!pendingBatch) {
    const batch = { tabs: new Set(), resolve: null, reject: null, promise: null };
    batch.promise = new Promise((resolve, reject) => {
      batch.resolve = resolve;
      batch.reject = reject;
    });
    pendingBatch = batch;
    queueMicrotask(() => flushBatch(batch));
  }
  pendingBatch.tabs.add(tab);
  return pendingBatch.promise.then((rowsByTab) => rowsByTab.get(tab) || []);
}

async function fetchSheetTab(tab) {
  return rowsToObjects(await fetchRawRows(tab));
}

function columnLetter(oneIndexedPosition) {
  return String.fromCharCode(64 + oneIndexedPosition); // 1 -> A, 7 -> G, etc.
}

// ---------------------------------- Reads ----------------------------------

export function getSheetId() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('sheetId');
  if (fromUrl) {
    localStorage.setItem(SHEET_ID_STORAGE_KEY, fromUrl);
    return Promise.resolve(fromUrl);
  }
  const cached = localStorage.getItem(SHEET_ID_STORAGE_KEY);
  if (cached) {
    return Promise.resolve(cached);
  }
  const configSheetId = window.KEYSTONE_CONFIG && window.KEYSTONE_CONFIG.sheetId;
  return Promise.resolve(configSheetId || DEFAULT_SHEET_ID);
}

export async function getPeople() {
  return fetchSheetTab('people');
}

export async function getHabits(personId) {
  const rows = await fetchSheetTab('habits');
  return rows
    .filter((row) => row.personId === personId)
    .map((row) => ({ ...row, active: parseBoolean(row.active) }));
}

export async function getTasks(personId) {
  const rows = await fetchSheetTab('tasks');
  return rows.filter((row) => row.personId === personId);
}

export async function getHabitLog(personId, dateISO) {
  const rows = await fetchSheetTab('habit_log');
  return rows.filter((row) => row.personId === personId && row.date === dateISO);
}

export async function getCheckpoints(personId, dateISO) {
  const rows = await fetchSheetTab('checkpoints');
  return rows
    .filter((row) => row.personId === personId && row.date === dateISO)
    .map((row) => ({ ...row, itemIds: parseList(row.itemIds), rewardIds: parseList(row.rewardIds) }));
}

export async function getRewardCatalog(personId) {
  const rows = await fetchSheetTab('reward_catalog');
  return rows
    .filter((row) => row.personId === personId)
    .map((row) => ({ ...row, tags: parseList(row.tags) }));
}

export async function getWeeklyRules(personId) {
  const rows = await fetchSheetTab('weekly_rules');
  return rows.filter((row) => row.personId === personId);
}

export async function getRewardLog(personId) {
  const rows = await fetchSheetTab('reward_log');
  return rows.filter((row) => row.personId === personId);
}

export async function getClasses(personId) {
  const rows = await fetchSheetTab('classes');
  return rows
    .filter((row) => row.personId === personId)
    .map((row) => ({
      ...row,
      daysOfWeek: parseList(row.daysOfWeek),
      durationMinutes: Number(row.durationMinutes) || 0,
      active: parseBoolean(row.active),
    }));
}

export async function getClassLog(personId, dateISO) {
  const rows = await fetchSheetTab('class_log');
  return rows.filter((row) => row.personId === personId && row.date === dateISO);
}

// Mirrors getHabitLogRange — same caller-given-range convention, no
// judgment about what the range should be.
export async function getClassLogRange(personId, fromDateISO, toDateISO) {
  const rows = await fetchSheetTab('class_log');
  return rows.filter((row) => row.personId === personId && row.date >= fromDateISO && row.date <= toDateISO);
}

export async function getDaySections(personId) {
  const rows = await fetchSheetTab('day_sections');
  return rows
    .filter((row) => row.personId === personId)
    .map((row) => ({ ...row, sortOrder: Number(row.sortOrder) || 0 }));
}

// One day's arrangement — which section each habit/task/class instance
// sits in and its order within that section. Separate from the
// habits/tasks/classes definition tabs (those stay definitional: what
// recurs); this is per-day placement (where it sits today). An item with
// no row here yet isn't an error — see groupItemsBySections in
// keystone-rules.js, which defaults unplaced items to the lowest-
// sortOrder section rather than requiring everything be manually placed.
export async function getDayPlan(personId, dateISO) {
  const rows = await fetchSheetTab('day_plan_items');
  return rows
    .filter((row) => row.personId === personId && row.date === dateISO)
    .map((row) => ({ ...row, itemSortOrder: Number(row.itemSortOrder) || 0 }));
}

// ---------------------------------- Writes ----------------------------------

// habit_log is append-only — every status change is a new row, never an
// edit of a past row (see CLAUDE.md's Data model section).
export async function setHabitStatus(dateISO, habitId, status) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const habits = await fetchSheetTab('habits');
  const habit = habits.find((h) => h.habitId === habitId);
  if (!habit) {
    throw new Error(`Unknown habitId: ${habitId}`);
  }

  const row = { date: dateISO, personId: habit.personId, habitId, status, checkpointId: '' };
  const values = SHEET_SCHEMA.habit_log.map((col) => row[col] ?? '');
  await appendRow(sheetId, accessToken, 'habit_log', values);
  return row;
}

// tasks rows mutate in place until done — this is the carry-forward
// mechanism, there is no copying of rows from day to day.
export async function setTaskStatus(taskId, status) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const rawRows = await fetchRawRows('tasks');
  const header = rawRows[0] || SHEET_SCHEMA.tasks;
  const dataRowIndex = rawRows.slice(1).findIndex((row) => row[0] === taskId);
  if (dataRowIndex === -1) {
    throw new Error(`Unknown taskId: ${taskId}`);
  }
  const sheetRowNumber = dataRowIndex + 2; // +1 for the header row, +1 for 1-indexing
  const existingRow = rawRows[dataRowIndex + 1];
  const task = header.reduce((obj, col, i) => {
    obj[col] = existingRow[i] !== undefined ? existingRow[i] : '';
    return obj;
  }, {});

  task.status = status;
  if (status === 'pending') {
    task.lastCarriedDate = todayISO();
  }

  const values = SHEET_SCHEMA.tasks.map((col) => task[col] ?? '');
  await updateRow(sheetId, accessToken, 'tasks', sheetRowNumber, values);
  return task;
}

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// slugified seed + short random suffix, so two rows created from the same
// text don't collide; not meant to be a durable public identifier scheme
// beyond that. Shared by every client-generated id (person, task, ...).
function generateId(prefix, seed) {
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${slugify(seed) || prefix}-${suffix}`;
}

// Shared by addPerson below and initializeSheet's backfill loop — new
// people get this immediately, people who predate day_sections get it
// backfilled next time Initialize Sheet is (re-)run.
async function seedDefaultDaySections(sheetId, accessToken, personId) {
  for (let i = 0; i < DEFAULT_DAY_SECTIONS.length; i += 1) {
    const name = DEFAULT_DAY_SECTIONS[i];
    const row = { sectionId: generateId('section', name), personId, name, sortOrder: i };
    const values = SHEET_SCHEMA.day_sections.map((col) => row[col] ?? '');
    await appendRow(sheetId, accessToken, 'day_sections', values);
  }
}

// Minimal Add Person slice pulled forward from Phase 8 — name + theme only,
// no avatar yet. No edit/delete of people, no profile switcher.
export async function addPerson(name, theme) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const row = { personId: generateId('person', name), name, theme, avatar: '' };
  const values = SHEET_SCHEMA.people.map((col) => row[col] ?? '');
  await appendRow(sheetId, accessToken, 'people', values);
  await seedDefaultDaySections(sheetId, accessToken, row.personId);
  return row;
}

// One-off task add from Plan Tomorrow. dueDate is optional (''  if unset).
export async function addTask(personId, label, dueDate) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const row = {
    taskId: generateId('task', label),
    personId,
    label,
    createdDate: todayISO(),
    dueDate: dueDate || '',
    status: 'pending',
    lastCarriedDate: '',
  };
  const values = SHEET_SCHEMA.tasks.map((col) => row[col] ?? '');
  await appendRow(sheetId, accessToken, 'tasks', values);
  return row;
}

// Habits are created going forward from the /habits page only — Today and
// Plan Tomorrow just render whatever's active, no add-habit UI there.
// sectionId is a habit's fixed home section (Phase 11 amendment) — unlike
// Tasks/Classes, whose section placement is a free per-day choice living
// only in day_plan_items, a habit's section is a property of the habit
// definition itself. Required at creation, same as label.
export async function addHabit(personId, label, sectionId) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const row = { habitId: generateId('habit', label), personId, label, active: true, sectionId };
  const values = SHEET_SCHEMA.habits.map((col) => row[col] ?? '');
  await appendRow(sheetId, accessToken, 'habits', values);
  return row;
}

export async function updateHabit(habitId, { label, sectionId }) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const rawRows = await fetchRawRows('habits');
  const header = rawRows[0] || SHEET_SCHEMA.habits;
  const existingRow = rawRows.slice(1).find((row) => row[header.indexOf('habitId')] === habitId);
  if (!existingRow) throw new Error(`Unknown habitId: ${habitId}`);
  const personId = existingRow[header.indexOf('personId')];
  const active = parseBoolean(existingRow[header.indexOf('active')]);

  const row = { habitId, personId, label, active, sectionId };
  await upsertRow(sheetId, accessToken, 'habits', 'habitId', habitId, row);
  return row;
}

// Deactivating hides a habit from Today/Plan Tomorrow without touching its
// habit_log history (append-only) — prefer this over deleting the habit
// row outright, which would orphan past log rows' habitId reference.
export async function setHabitActive(habitId, active) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const rawRows = await fetchRawRows('habits');
  const header = rawRows[0] || SHEET_SCHEMA.habits;
  const existingRow = rawRows.slice(1).find((row) => row[header.indexOf('habitId')] === habitId);
  if (!existingRow) throw new Error(`Unknown habitId: ${habitId}`);
  const personId = existingRow[header.indexOf('personId')];
  const label = existingRow[header.indexOf('label')];
  const sectionId = existingRow[header.indexOf('sectionId')];

  const row = { habitId, personId, label, active, sectionId };
  await upsertRow(sheetId, accessToken, 'habits', 'habitId', habitId, row);
  return row;
}

// Classes are a distinct entity from habits (see CLAUDE.md's Classes phase
// for the DDD reasoning) — weekday+time-bound, not daily-reset, with their
// own log. CRUD follows the exact addHabit/updateHabit/setHabitActive
// pattern below.
export async function addClass(personId, name, daysOfWeek, startTime, durationMinutes) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const row = {
    classId: generateId('class', name),
    personId,
    name,
    daysOfWeek: (daysOfWeek || []).join(','),
    startTime: startTime || '',
    durationMinutes: Number(durationMinutes) || 0,
    active: true,
  };
  const values = SHEET_SCHEMA.classes.map((col) => row[col] ?? '');
  await appendRow(sheetId, accessToken, 'classes', values);
  return { ...row, daysOfWeek: daysOfWeek || [] };
}

export async function updateClass(classId, { name, daysOfWeek, startTime, durationMinutes }) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const rawRows = await fetchRawRows('classes');
  const header = rawRows[0] || SHEET_SCHEMA.classes;
  const existingRow = rawRows.slice(1).find((row) => row[header.indexOf('classId')] === classId);
  if (!existingRow) throw new Error(`Unknown classId: ${classId}`);
  const personId = existingRow[header.indexOf('personId')];
  const active = parseBoolean(existingRow[header.indexOf('active')]);

  const row = {
    classId,
    personId,
    name,
    daysOfWeek: (daysOfWeek || []).join(','),
    startTime: startTime || '',
    durationMinutes: Number(durationMinutes) || 0,
    active,
  };
  await upsertRow(sheetId, accessToken, 'classes', 'classId', classId, row);
  return { ...row, daysOfWeek: daysOfWeek || [] };
}

// Deactivating hides a class from Today/Plan Tomorrow without touching its
// class_log history — same append-only-history rationale as
// setHabitActive above.
export async function setClassActive(classId, active) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const rawRows = await fetchRawRows('classes');
  const header = rawRows[0] || SHEET_SCHEMA.classes;
  const existingRow = rawRows.slice(1).find((row) => row[header.indexOf('classId')] === classId);
  if (!existingRow) throw new Error(`Unknown classId: ${classId}`);
  const personId = existingRow[header.indexOf('personId')];
  const name = existingRow[header.indexOf('name')];
  const daysOfWeek = existingRow[header.indexOf('daysOfWeek')];
  const startTime = existingRow[header.indexOf('startTime')];
  const durationMinutes = existingRow[header.indexOf('durationMinutes')];

  const row = { classId, personId, name, daysOfWeek, startTime, durationMinutes, active };
  await upsertRow(sheetId, accessToken, 'classes', 'classId', classId, row);
  return { ...row, daysOfWeek: parseList(daysOfWeek) };
}

// class_log is append-only, same convention as habit_log — done/skipped/
// rescheduled all funnel through this one entry point. `options` carries
// whichever field is specific to the status being logged: `rescheduledTo`
// for 'rescheduled', `skippedBy` for 'skipped'. skippedBy defaults to
// 'student' whenever a skip is logged without an explicit override —
// teacher-cancelled sessions are the exception that has to be asked for
// (a distinct button in the UI), not the default, since who skipped
// changes what the number means for attendance reporting (see
// evaluateClassAttendance in keystone-rules.js).
export async function logClassStatus(classId, personId, dateISO, status, options = {}) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const row = {
    classId,
    personId,
    date: dateISO,
    status,
    rescheduledTo: options.rescheduledTo || '',
    skippedBy: status === 'skipped' ? options.skippedBy || 'student' : '',
  };
  const values = SHEET_SCHEMA.class_log.map((col) => row[col] ?? '');
  await appendRow(sheetId, accessToken, 'class_log', values);
  return row;
}

// ---- Day sections (Phase 11): per-person config, not global — matches
// the existing config-over-one-off-logic convention. Groundwork for a
// later calendar/specific-time view; this phase is just the section/
// ordering data model, not a calendar grid. ----

export async function addDaySection(personId, name, sortOrder) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const row = { sectionId: generateId('section', name), personId, name, sortOrder };
  const values = SHEET_SCHEMA.day_sections.map((col) => row[col] ?? '');
  await appendRow(sheetId, accessToken, 'day_sections', values);
  return row;
}

export async function updateDaySection(sectionId, { name, sortOrder }) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const rawRows = await fetchRawRows('day_sections');
  const header = rawRows[0] || SHEET_SCHEMA.day_sections;
  const existingRow = rawRows.slice(1).find((row) => row[header.indexOf('sectionId')] === sectionId);
  if (!existingRow) throw new Error(`Unknown sectionId: ${sectionId}`);
  const personId = existingRow[header.indexOf('personId')];

  const row = { sectionId, personId, name, sortOrder };
  await upsertRow(sheetId, accessToken, 'day_sections', 'sectionId', sectionId, row);
  return row;
}

// Deleting a section never touches day_plan_items — an item whose
// sectionId no longer matches any existing section just falls back to
// the lowest-sortOrder section on read (see groupItemsBySections in
// keystone-rules.js), the same self-healing-on-read approach used
// elsewhere (isCheckpointReady, getUnclosedHabits). No cascade needed,
// and nothing "silently disappears" — it reappears in the fallback
// section next load.
export async function deleteDaySection(sectionId) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();
  return deleteRowById(sheetId, accessToken, 'day_sections', 'sectionId', sectionId);
}

// day_plan_items has no single-column identity — personId+date+itemType+
// itemId together identify "where does this specific item sit on this
// day," so this upserts on that composite match rather than reusing the
// single-idColumn upsertRow helper below. Rows here mutate in place as
// the user drags/reassigns — unlike habit_log/class_log, this tab is NOT
// append-only, since it's current placement, not history.
export async function upsertDayPlanItem(personId, dateISO, itemType, itemId, sectionId, itemSortOrder) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const rawRows = await fetchRawRows('day_plan_items');
  const header = rawRows[0] || SHEET_SCHEMA.day_plan_items;
  const idx = {
    personId: header.indexOf('personId'),
    date: header.indexOf('date'),
    itemType: header.indexOf('itemType'),
    itemId: header.indexOf('itemId'),
  };
  const dataRowIndex = rawRows.slice(1).findIndex(
    (row) =>
      row[idx.personId] === personId &&
      row[idx.date] === dateISO &&
      row[idx.itemType] === itemType &&
      row[idx.itemId] === itemId
  );

  const row = { personId, date: dateISO, itemType, itemId, sectionId, itemSortOrder };
  const values = SHEET_SCHEMA.day_plan_items.map((col) => row[col] ?? '');
  if (dataRowIndex === -1) {
    await appendRow(sheetId, accessToken, 'day_plan_items', values);
  } else {
    const sheetRowNumber = dataRowIndex + 2; // +1 header, +1 1-indexing
    await updateRow(sheetId, accessToken, 'day_plan_items', sheetRowNumber, values);
  }
  return row;
}

// Finds an existing row by idColumn === idValue and PUTs an update in
// place; if not found, appends a new row. Shared by checkpoints and
// reward_catalog, whose rows are edited after creation (unlike habit_log's
// append-only history or people/tasks' single-purpose writers above).
async function upsertRow(sheetId, accessToken, tabName, idColumn, idValue, rowObject) {
  const rawRows = await fetchRawRows(tabName);
  const header = rawRows[0] || SHEET_SCHEMA[tabName];
  const idIndex = header.indexOf(idColumn);
  const dataRowIndex = rawRows.slice(1).findIndex((row) => row[idIndex] === idValue);

  const values = SHEET_SCHEMA[tabName].map((col) => rowObject[col] ?? '');
  if (dataRowIndex === -1) {
    await appendRow(sheetId, accessToken, tabName, values);
  } else {
    const sheetRowNumber = dataRowIndex + 2; // +1 header, +1 1-indexing
    await updateRow(sheetId, accessToken, tabName, sheetRowNumber, values);
  }
  return rowObject;
}

// Deletes the row matching idColumn === idValue from tabName. Needs the
// tab's numeric grid sheetId (distinct from the spreadsheet id), fetched
// fresh each call — reward catalog deletes are rare, not worth caching.
async function deleteRowById(sheetId, accessToken, tabName, idColumn, idValue) {
  const rawRows = await fetchRawRows(tabName);
  const header = rawRows[0] || SHEET_SCHEMA[tabName];
  const idIndex = header.indexOf(idColumn);
  const dataRowIndex = rawRows.slice(1).findIndex((row) => row[idIndex] === idValue);
  if (dataRowIndex === -1) return false;

  const meta = await sheetsApiRequest(`${sheetId}?fields=sheets.properties`, accessToken);
  const tabProps = (meta.sheets || []).map((s) => s.properties).find((p) => p.title === tabName);
  if (!tabProps) return false;

  const sheetRowIndex = dataRowIndex + 1; // 0-indexed, +1 to skip header row
  await batchUpdate(sheetId, accessToken, [{
    deleteDimension: {
      range: {
        sheetId: tabProps.sheetId,
        dimension: 'ROWS',
        startIndex: sheetRowIndex,
        endIndex: sheetRowIndex + 1,
      },
    },
  }]);
  return true;
}

// Checkpoints are planned once, then mutate in place (status -> 'granted')
// — upsert semantics, same as tasks, unlike habit_log's append-only history.
export async function upsertCheckpoint(checkpoint) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const checkpointId = checkpoint.checkpointId || generateId('checkpoint', checkpoint.label);
  const row = {
    ...checkpoint,
    checkpointId,
    itemIds: (checkpoint.itemIds || []).join(','),
    rewardIds: (checkpoint.rewardIds || []).join(','),
  };
  await upsertRow(sheetId, accessToken, 'checkpoints', 'checkpointId', checkpointId, row);
  return { ...checkpoint, checkpointId };
}

// ---- Reward catalog CRUD (per person) ----

export async function addReward(personId, title, tags) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const row = { rewardId: generateId('reward', title), personId, title, tags: (tags || []).join(',') };
  const values = SHEET_SCHEMA.reward_catalog.map((col) => row[col] ?? '');
  await appendRow(sheetId, accessToken, 'reward_catalog', values);
  return { ...row, tags: tags || [] };
}

export async function updateReward(rewardId, title, tags) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const rawRows = await fetchRawRows('reward_catalog');
  const header = rawRows[0] || SHEET_SCHEMA.reward_catalog;
  const existingRow = rawRows.slice(1).find((row) => row[header.indexOf('rewardId')] === rewardId);
  if (!existingRow) throw new Error(`Unknown rewardId: ${rewardId}`);
  const personId = existingRow[header.indexOf('personId')];

  const row = { rewardId, personId, title, tags: (tags || []).join(',') };
  await upsertRow(sheetId, accessToken, 'reward_catalog', 'rewardId', rewardId, row);
  return { ...row, tags: tags || [] };
}

export async function deleteReward(rewardId) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();
  return deleteRowById(sheetId, accessToken, 'reward_catalog', 'rewardId', rewardId);
}

// Parent-initiated, callable at any completion % — never automatic. Writes
// an append-only reward_log row, then flips the matching checkpoint's
// status to 'granted' (checkpoints mutate in place; reward_log does not).
export async function grantReward(checkpointIdOrWeekId, rewardChosen, grantedBy) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const checkpointRows = await fetchSheetTab('checkpoints');
  const checkpoint = checkpointRows
    .map((row) => ({ ...row, itemIds: parseList(row.itemIds), rewardIds: parseList(row.rewardIds) }))
    .find((cp) => cp.checkpointId === checkpointIdOrWeekId);

  const row = {
    date: todayISO(),
    personId: checkpoint ? checkpoint.personId : '',
    checkpointIdOrWeekId,
    rewardChosen,
    grantedBy,
    status: 'granted',
  };
  const values = SHEET_SCHEMA.reward_log.map((col) => row[col] ?? '');
  await appendRow(sheetId, accessToken, 'reward_log', values);

  if (checkpoint) {
    await upsertRow(sheetId, accessToken, 'checkpoints', 'checkpointId', checkpoint.checkpointId, {
      ...checkpoint,
      itemIds: (checkpoint.itemIds || []).join(','),
      rewardIds: (checkpoint.rewardIds || []).join(','),
      status: 'granted',
    });
  }

  return { ...row };
}

// Multi-day habit_log read for reports/weekly-rule evaluation — still just
// filtering by the caller's requested range, not deciding what the range
// should be (that judgment call stays in src/pages/Report.tsx).
export async function getHabitLogRange(personId, fromDateISO, toDateISO) {
  const rows = await fetchSheetTab('habit_log');
  return rows.filter((row) => row.personId === personId && row.date >= fromDateISO && row.date <= toDateISO);
}

// ------------------------------ Setup (OAuth) ------------------------------
// The one write action pulled forward from Phase 3: bootstraps a sheet's
// tab structure so it never has to be hand-edited in Google Sheets.

async function sheetsApiRequest(path, accessToken, options = {}) {
  const response = await fetch(`${SHEETS_API_BASE}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sheets API request failed (${response.status}): ${body}`);
  }
  return response.json();
}

function batchUpdate(sheetId, accessToken, requests) {
  return sheetsApiRequest(`${sheetId}:batchUpdate`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
}

function writeHeaderRow(sheetId, accessToken, tabName, headers) {
  return sheetsApiRequest(`${sheetId}/values/${tabName}!A1?valueInputOption=RAW`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ values: [headers] }),
  });
}

async function isTabEmpty(sheetId, accessToken, tabName) {
  const data = await sheetsApiRequest(`${sheetId}/values/${tabName}`, accessToken);
  return !data.values || data.values.length === 0;
}

async function readTabValues(sheetId, accessToken, tabName) {
  const data = await sheetsApiRequest(`${sheetId}/values/${tabName}`, accessToken);
  return data.values || [];
}

function appendRow(sheetId, accessToken, tabName, values) {
  return sheetsApiRequest(`${sheetId}/values/${tabName}!A:Z:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ values: [values] }),
  });
}

function updateRow(sheetId, accessToken, tabName, rowNumber, values) {
  const range = `${tabName}!A${rowNumber}:${columnLetter(values.length)}${rowNumber}`;
  return sheetsApiRequest(`${sheetId}/values/${range}?valueInputOption=RAW`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ values: [values] }),
  });
}

// Idempotent: safe to call multiple times. Only ever adds tabs/headers that
// are missing, and only removes a leftover default tab (e.g. "Sheet1") when
// it's empty — never destroys data defensively.
export async function initializeSheet(sheetId, accessToken) {
  const meta = await sheetsApiRequest(`${sheetId}?fields=sheets.properties`, accessToken);
  const existingSheets = (meta.sheets || []).map((s) => s.properties);
  const existingTitles = new Set(existingSheets.map((p) => p.title));

  const tabNames = Object.keys(SHEET_SCHEMA);
  const created = [];
  const alreadyExisted = [];
  const addSheetRequests = [];

  for (const tabName of tabNames) {
    if (existingTitles.has(tabName)) {
      alreadyExisted.push(tabName);
    } else {
      created.push(tabName);
      addSheetRequests.push({ addSheet: { properties: { title: tabName } } });
    }
  }

  if (addSheetRequests.length > 0) {
    await batchUpdate(sheetId, accessToken, addSheetRequests);
  }

  for (const tabName of tabNames) {
    await writeHeaderRow(sheetId, accessToken, tabName, SHEET_SCHEMA[tabName]);
  }

  const deleted = [];
  const leftoverSheets = existingSheets.filter((p) => !tabNames.includes(p.title));
  for (const sheetProps of leftoverSheets) {
    if (await isTabEmpty(sheetId, accessToken, sheetProps.title)) {
      await batchUpdate(sheetId, accessToken, [{ deleteSheet: { sheetId: sheetProps.sheetId } }]);
      deleted.push(sheetProps.title);
    }
  }

  // Backfill default day_sections for any person who predates this
  // feature (addPerson seeds new people immediately — see
  // seedDefaultDaySections above — this only catches the gap for people
  // created before day_sections existed). Idempotent: skips anyone who
  // already has at least one day_sections row.
  const peopleValues = await readTabValues(sheetId, accessToken, 'people');
  const daySectionValues = await readTabValues(sheetId, accessToken, 'day_sections');
  const peopleHeader = peopleValues[0] || SHEET_SCHEMA.people;
  const sectionHeader = daySectionValues[0] || SHEET_SCHEMA.day_sections;
  const personIdIndex = peopleHeader.indexOf('personId');
  const sectionPersonIdIndex = sectionHeader.indexOf('personId');
  const peopleWithSections = new Set(daySectionValues.slice(1).map((row) => row[sectionPersonIdIndex]));

  const seededDaySectionsFor = [];
  for (const row of peopleValues.slice(1)) {
    const personId = row[personIdIndex];
    if (peopleWithSections.has(personId)) continue;
    await seedDefaultDaySections(sheetId, accessToken, personId);
    seededDaySectionsFor.push(personId);
  }

  return { created, alreadyExisted, deleted, seededDaySectionsFor };
}
