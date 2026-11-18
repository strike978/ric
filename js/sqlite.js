/*
 * SQLite backup
 *
 * Export builds a real SQLite database in memory with sql.js and returns its
 * bytes, so the saved file is a genuine .db that any SQLite tool can open.
 *
 * Layout:
 *   metadata              format, version, exported_at
 *   profiles              one row per saved DNA relatives list
 *   relatives             one row per saved relative, ordered by row_position
 *   pairs                 one row per saved relatives-in-common comparison
 *   relatives_in_common   one row per relative in common, ordered by row_position
 *
 * Every saved field becomes its own column, discovered from the data. Common
 * fields are easy to query; booleans are stored as 0 or 1.
 *
 * Import validates the file before anything in IndexedDB changes. It reads
 * only this layout, not arbitrary SQLite databases.
 */

import { EXPORT_FORMAT, exportDatabaseRecords } from './db.js';

const DATABASE_VERSION = 1;

const PROFILE_TABLE = 'profiles';
const RELATIVE_TABLE = 'relatives';
const PAIR_TABLE = 'pairs';
const COMMON_TABLE = 'relatives_in_common';
const METADATA_TABLE = 'metadata';

// Columns that belong to the file itself, not to a saved relative.
const RELATIVE_STRUCTURE = [
  { name: 'owner_profile_id', type: 'TEXT', notNull: true },
  { name: 'row_position', type: 'INTEGER', notNull: true },
];

const COMMON_STRUCTURE = [
  { name: 'owner_profile_id', type: 'TEXT', notNull: true },
  { name: 'pair_relative_id', type: 'TEXT', notNull: true },
  { name: 'row_position', type: 'INTEGER', notNull: true },
];

let sqlitePromise = null;

// sql-wasm-browser.js is loaded by index.html and defines the global
// `initSqlJs`. The WASM file is fetched only when a backup is first used.
function loadSqlite() {
  if (sqlitePromise) return sqlitePromise;

  const init = typeof window !== 'undefined' ? window.initSqlJs : undefined;
  if (typeof init !== 'function') {
    throw new Error('the SQLite engine did not load');
  }

  sqlitePromise = init({
    locateFile: (name) => chrome.runtime.getURL('vendor/' + name),
  }).catch((err) => {
    sqlitePromise = null;
    throw err;
  });

  return sqlitePromise;
}

/* ---------- Field discovery ---------- */

function createColumnMap() {
  return new Map();
}

function addRelativeColumns(columns, relative, reserved, ownerId) {
  if (!relative || typeof relative !== 'object' || Array.isArray(relative)) {
    throw new Error('a saved relative is not an object');
  }

  for (const key of Object.keys(relative)) {
    if (reserved.some((column) => column.name === key)) {
      throw new Error('saved field "' + key + '" conflicts with a backup column name');
    }

    const value = relative[key];
    if (value === undefined) continue;

    // In the main relatives list, profile_id repeats the owning profile.
    // owner_profile_id already stores it, so skip the duplicate column.
    if (key === 'profile_id' && ownerId !== undefined && value === ownerId) continue;

    let state = columns.get(key);
    if (!state) {
      state = { bool: false, number: false, fraction: false, string: false, other: false };
      columns.set(key, state);
    }

    if (value === null) continue;

    if (typeof value === 'boolean') state.bool = true;
    else if (typeof value === 'number') {
      state.number = true;
      if (!Number.isInteger(value)) state.fraction = true;
    } else if (typeof value === 'string') state.string = true;
    else state.other = true;
  }
}

// Mixed-type columns are left untyped so SQLite keeps each value's own type.
function sqlType(state) {
  if (state.other) return '';
  if (state.number && state.string) return '';
  if (state.bool && state.string) return '';
  if (state.number) return state.fraction ? 'REAL' : 'INTEGER';
  if (state.bool) return 'INTEGER';
  return 'TEXT';
}

function columnDefinitions(columns) {
  return [...columns].map(([name, state]) => ({ name, type: sqlType(state) }));
}

async function collectColumns() {
  const relatives = createColumnMap();
  const common = createColumnMap();

  for await (const record of exportDatabaseRecords()) {
    if (!record.type) continue;

    const isProfile = record.type === 'profile_relatives';
    const columns = isProfile ? relatives : common;
    const reserved = isProfile ? RELATIVE_STRUCTURE : COMMON_STRUCTURE;

    for (const relative of record.relatives) {
      addRelativeColumns(columns, relative, reserved, isProfile ? record.profile_id : undefined);
    }
  }

  return {
    relatives: columnDefinitions(relatives),
    common: columnDefinitions(common),
  };
}

/* ---------- Building the database ---------- */

function quoteIdentifier(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function columnDefinition(column) {
  return quoteIdentifier(column.name)
    + (column.type ? ' ' + column.type : '')
    + (column.notNull ? ' NOT NULL' : '');
}

function createTableSql(name, structure, columns, primaryKey) {
  const definitions = [
    ...structure.map(columnDefinition),
    ...columns.map(columnDefinition),
    'PRIMARY KEY (' + primaryKey + ')',
  ];

  return 'CREATE TABLE ' + name + ' (\n  ' + definitions.join(',\n  ') + '\n);';
}

function insertSql(table, structure, columns) {
  const names = [...structure.map((column) => column.name), ...columns.map((column) => column.name)];

  return 'INSERT INTO ' + table + ' (' + names.map(quoteIdentifier).join(', ') + ') VALUES ('
    + names.map(() => '?').join(', ') + ');';
}

function bindValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();

  return JSON.stringify(value);
}

// Builds the whole database in memory and returns its bytes. `counts` is
// updated while writing, for the "Exported N profiles" notice.
export async function exportDatabaseFile(counts) {
  const SQL = await loadSqlite();
  const columns = await collectColumns();
  const db = new SQL.Database();

  try {
    db.run('CREATE TABLE ' + METADATA_TABLE + ' (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    db.run('CREATE TABLE ' + PROFILE_TABLE
      + ' (profile_id TEXT PRIMARY KEY, row_position INTEGER NOT NULL);');
    db.run(createTableSql(RELATIVE_TABLE, RELATIVE_STRUCTURE, columns.relatives,
      'owner_profile_id, row_position'));
    db.run('CREATE TABLE ' + PAIR_TABLE + ' (profile_id TEXT NOT NULL, '
      + 'relative_profile_id TEXT NOT NULL, row_position INTEGER NOT NULL, '
      + 'PRIMARY KEY (profile_id, relative_profile_id));');
    db.run(createTableSql(COMMON_TABLE, COMMON_STRUCTURE, columns.common,
      'owner_profile_id, pair_relative_id, row_position'));

    const metadata = db.prepare('INSERT INTO ' + METADATA_TABLE + ' (key, value) VALUES (?, ?);');
    metadata.run(['format', EXPORT_FORMAT]);
    metadata.run(['version', String(DATABASE_VERSION)]);
    metadata.run(['exported_at', new Date().toISOString()]);
    metadata.free();

    const insertProfile = db.prepare('INSERT INTO ' + PROFILE_TABLE
      + ' (profile_id, row_position) VALUES (?, ?);');
    const insertRelative = db.prepare(insertSql(RELATIVE_TABLE, RELATIVE_STRUCTURE, columns.relatives));
    const insertPair = db.prepare('INSERT INTO ' + PAIR_TABLE
      + ' (profile_id, relative_profile_id, row_position) VALUES (?, ?, ?);');
    const insertCommon = db.prepare(insertSql(COMMON_TABLE, COMMON_STRUCTURE, columns.common));

    let profilePosition = 0;
    let pairProfile = null;
    let pairPosition = 0;

    db.run('BEGIN TRANSACTION;');

    try {
      for await (const record of exportDatabaseRecords()) {
        if (!record.type) continue;

        if (record.type === 'profile_relatives') {
          counts.profiles++;
          insertProfile.run([record.profile_id, profilePosition++]);

          for (let position = 0; position < record.relatives.length; position++) {
            const relative = record.relatives[position];
            insertRelative.run([
              record.profile_id,
              position,
              ...columns.relatives.map((column) => bindValue(relative[column.name])),
            ]);
          }
          continue;
        }

        if (pairProfile !== record.profile_id) {
          pairProfile = record.profile_id;
          pairPosition = 0;
        }

        counts.comparisons++;
        insertPair.run([record.profile_id, record.relative_profile_id, pairPosition++]);

        for (let position = 0; position < record.relatives.length; position++) {
          const relative = record.relatives[position];
          insertCommon.run([
            record.profile_id,
            record.relative_profile_id,
            position,
            ...columns.common.map((column) => bindValue(relative[column.name])),
          ]);
        }
      }

      db.run('COMMIT;');
    } catch (err) {
      try { db.run('ROLLBACK;'); } catch { /* ignore */ }
      throw err;
    } finally {
      insertProfile.free();
      insertRelative.free();
      insertPair.free();
      insertCommon.free();
    }

    return db.export();
  } finally {
    db.close();
  }
}

/* ---------- Reading a backup ---------- */

function tableColumns(db, name) {
  const result = db.exec('PRAGMA table_info(' + quoteIdentifier(name) + ');');
  return new Set(result.length ? result[0].values.map((row) => String(row[1])) : []);
}

function requireColumns(db, table, required) {
  const columns = tableColumns(db, table);

  for (const name of required) {
    if (!columns.has(name)) {
      throw new Error('the database is missing the ' + table + '.' + name + ' column');
    }
  }
}

function hasRows(db, sql) {
  const result = db.exec(sql);
  return Boolean(result.length && result[0].values.length);
}

function assertClean(db, sql, message) {
  if (hasRows(db, sql)) throw new Error(message);
}

function countRows(db, table) {
  const result = db.exec('SELECT COUNT(*) FROM ' + table + ';');
  return result.length ? Number(result[0].values[0][0]) : 0;
}

function validateDatabase(db) {
  let metadata;
  try {
    const result = db.exec('SELECT key, value FROM ' + METADATA_TABLE + ';');
    metadata = new Map();
    if (result.length) {
      for (const [key, value] of result[0].values) metadata.set(String(key), String(value));
    }
  } catch {
    throw new Error('the file is not a Relatives in Common database');
  }

  if (metadata.get('format') !== EXPORT_FORMAT) {
    throw new Error('the file is not a Relatives in Common database');
  }

  // The version is informational. Import reads the tables and columns it finds,
  // so backups written by any version of Export can still be opened.

  const tables = new Set();
  const tableResult = db.exec("SELECT name FROM sqlite_schema WHERE type = 'table';");
  if (tableResult.length) {
    for (const row of tableResult[0].values) tables.add(String(row[0]));
  }

  for (const name of [PROFILE_TABLE, RELATIVE_TABLE, PAIR_TABLE, COMMON_TABLE]) {
    if (!tables.has(name)) throw new Error('the database is missing the ' + name + ' table');
  }

  requireColumns(db, PROFILE_TABLE, ['profile_id', 'row_position']);
  requireColumns(db, RELATIVE_TABLE, ['owner_profile_id', 'row_position']);
  requireColumns(db, PAIR_TABLE, ['profile_id', 'relative_profile_id', 'row_position']);
  requireColumns(db, COMMON_TABLE, ['owner_profile_id', 'pair_relative_id', 'row_position']);

  assertClean(db,
    'SELECT 1 FROM ' + PROFILE_TABLE
      + " WHERE profile_id IS NULL OR profile_id = ''"
      + " OR row_position IS NULL OR typeof(row_position) <> 'integer' OR row_position < 0 LIMIT 1;",
    'the database has an invalid profile row');

  assertClean(db,
    'SELECT 1 FROM ' + PAIR_TABLE
      + " WHERE profile_id IS NULL OR profile_id = ''"
      + " OR relative_profile_id IS NULL OR relative_profile_id = ''"
      + " OR row_position IS NULL OR typeof(row_position) <> 'integer' OR row_position < 0 LIMIT 1;",
    'the database has an invalid comparison row');

  assertClean(db,
    'SELECT 1 FROM ' + RELATIVE_TABLE
      + " WHERE owner_profile_id IS NULL OR owner_profile_id = ''"
      + " OR row_position IS NULL OR typeof(row_position) <> 'integer' OR row_position < 0 LIMIT 1;",
    'the database has an invalid relative row');

  assertClean(db,
    'SELECT 1 FROM ' + COMMON_TABLE
      + " WHERE owner_profile_id IS NULL OR owner_profile_id = ''"
      + " OR pair_relative_id IS NULL OR pair_relative_id = ''"
      + " OR row_position IS NULL OR typeof(row_position) <> 'integer' OR row_position < 0 LIMIT 1;",
    'the database has an invalid relative-in-common row');

  assertClean(db,
    'SELECT 1 FROM ' + PROFILE_TABLE + ' GROUP BY profile_id HAVING COUNT(*) > 1 LIMIT 1;',
    'the database has duplicate profiles');

  assertClean(db,
    'SELECT 1 FROM ' + PAIR_TABLE
      + ' GROUP BY profile_id, relative_profile_id HAVING COUNT(*) > 1 LIMIT 1;',
    'the database has duplicate comparisons');

  assertClean(db,
    'SELECT 1 FROM ' + RELATIVE_TABLE
      + ' GROUP BY owner_profile_id, row_position HAVING COUNT(*) > 1 LIMIT 1;',
    'the database has duplicate relative positions');

  assertClean(db,
    'SELECT 1 FROM ' + COMMON_TABLE
      + ' GROUP BY owner_profile_id, pair_relative_id, row_position HAVING COUNT(*) > 1 LIMIT 1;',
    'the database has duplicate relative-in-common positions');

  assertClean(db,
    'SELECT 1 FROM ' + RELATIVE_TABLE + ' r WHERE NOT EXISTS'
      + ' (SELECT 1 FROM ' + PROFILE_TABLE + ' p WHERE p.profile_id = r.owner_profile_id) LIMIT 1;',
    'a relative row has no matching profile');

  assertClean(db,
    'SELECT 1 FROM ' + COMMON_TABLE + ' c WHERE NOT EXISTS'
      + ' (SELECT 1 FROM ' + PAIR_TABLE + ' p WHERE p.profile_id = c.owner_profile_id'
      + ' AND p.relative_profile_id = c.pair_relative_id) LIMIT 1;',
    'a relative-in-common row has no matching comparison');
}

// Rebuilds one relative from a row. `ownerId` is set for the main relatives
// table, where profile_id is just the owning profile and may have been omitted
// as a duplicate column.
function relativeFromRow(row, structure, ownerId) {
  const relative = {};

  for (const [column, value] of Object.entries(row)) {
    if (structure.some((item) => item.name === column)) continue;
    if (value === null || value === undefined) continue;
    relative[column] = value;
  }

  if (ownerId !== undefined && relative.profile_id === undefined) {
    relative.profile_id = ownerId;
  }

  return relative;
}

async function* databaseRecords(db) {
  const profiles = db.prepare('SELECT profile_id FROM ' + PROFILE_TABLE
    + ' ORDER BY row_position, profile_id;');
  const relatives = db.prepare('SELECT * FROM ' + RELATIVE_TABLE
    + ' WHERE owner_profile_id = ? ORDER BY row_position;');

  try {
    while (profiles.step()) {
      const profileId = String(profiles.getAsObject().profile_id);
      const list = [];

      relatives.bind([profileId]);
      while (relatives.step()) {
        list.push(relativeFromRow(relatives.getAsObject(), RELATIVE_STRUCTURE, profileId));
      }
      relatives.reset();

      yield { type: 'profile_relatives', profile_id: profileId, relatives: list };
    }
  } finally {
    profiles.free();
    relatives.free();
  }

  const pairs = db.prepare('SELECT profile_id, relative_profile_id FROM ' + PAIR_TABLE
    + ' ORDER BY profile_id, row_position;');
  const common = db.prepare('SELECT * FROM ' + COMMON_TABLE
    + ' WHERE owner_profile_id = ? AND pair_relative_id = ? ORDER BY row_position;');

  try {
    while (pairs.step()) {
      const pair = pairs.getAsObject();
      const profileId = String(pair.profile_id);
      const relativeId = String(pair.relative_profile_id);
      const list = [];

      common.bind([profileId, relativeId]);
      while (common.step()) list.push(relativeFromRow(common.getAsObject(), COMMON_STRUCTURE));
      common.reset();

      yield {
        type: 'pair',
        profile_id: profileId,
        relative_profile_id: relativeId,
        relatives: list,
      };
    }
  } finally {
    pairs.free();
    common.free();
  }
}

// Opens and validates a backup. The returned records generator only reads
// from the in-memory database, so it stays usable until close() is called.
export async function readDatabaseBackup(bytes) {
  const SQL = await loadSqlite();
  let db;

  try {
    db = new SQL.Database(bytes);
    validateDatabase(db);
  } catch (err) {
    if (db) db.close();
    throw err;
  }

  return {
    profiles: countRows(db, PROFILE_TABLE),
    comparisons: countRows(db, PAIR_TABLE),
    records: () => databaseRecords(db),
    close: () => db.close(),
  };
}
