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
// shared/keystone-auth.js and app/*.html, never here.

export const SHEET_SCHEMA = {
  people: ['personId', 'name', 'theme', 'avatar'],
  habits: ['habitId', 'personId', 'label', 'active'],
  tasks: ['taskId', 'personId', 'label', 'createdDate', 'dueDate', 'status', 'lastCarriedDate'],
  habit_log: ['date', 'personId', 'habitId', 'status', 'checkpointId'],
  checkpoints: ['date', 'personId', 'checkpointId', 'label', 'itemIds', 'rewardMode', 'rewardIds', 'status'],
  reward_catalog: ['rewardId', 'personId', 'title', 'tags'],
  weekly_rules: ['personId', 'metric', 'rewardId'],
  reward_log: ['date', 'personId', 'checkpointIdOrWeekId', 'rewardChosen', 'grantedBy', 'status'],
};

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// Template Sheet for local dev/testing — already created, tabs not yet
// initialized (run app/setup.html against it). Bring-your-own-sheet users
// override via ?sheetId= or config.local.js's sheetId.
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

async function fetchRawRows(tab) {
  const sheetId = await getSheetId();
  const apiKey = getApiKey();
  const url = `${SHEETS_API_BASE}/${sheetId}/values/${tab}!A:Z?key=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${tab}: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return data.values || [];
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

// Minimal Add Person slice pulled forward from Phase 8 — name + theme only,
// no avatar yet. No edit/delete of people, no profile switcher.
export async function addPerson(name, theme) {
  const accessToken = requireAccessToken();
  const sheetId = await getSheetId();

  const row = { personId: generateId('person', name), name, theme, avatar: '' };
  const values = SHEET_SCHEMA.people.map((col) => row[col] ?? '');
  await appendRow(sheetId, accessToken, 'people', values);
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
  const checkpoint = checkpointRows.find((cp) => cp.checkpointId === checkpointIdOrWeekId);

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
// should be (that judgment call stays in app/report.html).
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

  return { created, alreadyExisted, deleted };
}
