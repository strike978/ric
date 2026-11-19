/*
 * Relative storage
 *
 * IndexedDB via Dexie. Each selected profile gets one record keyed by its
 * profile id in `profile_relatives`, holding that profile's relatives as an
 * array sorted by IBD proportion. Loading a profile again replaces its record.
 *
 * The `relatives_in_common` store has one record per profile too, holding a
 * `pairs` array: one item per compared relative, with that pair's common
 * relatives in `relatives`.
 *
 * The database is a development cache with a single schema version.
 */

import Dexie from '../vendor/dexie.mjs';
import { EXPORT_FORMAT, EXPORT_VERSION } from './reader.js';

const DB_NAME = 'relatives-in-common';

function createDb() {
  const db = new Dexie(DB_NAME);

  db.version(1).stores({
    // Old development names; removed if the local database still has them.
    profiles: null,
    comparisons: null,
    profile_relatives: 'profile_id',
    relatives_in_common: 'profile_id',
  });

  return db;
}

let db = createDb();

// Missing or non-numeric proportions sort last.
function ibdValue(relative) {
  const value = Number(relative.ibd_proportion);
  return Number.isFinite(value) ? value : -Infinity;
}

function byIbdDescending(a, b) {
  return ibdValue(b) - ibdValue(a);
}

// Replaces the record for one profile, highest IBD proportion first.
export async function saveRelatives(profileId, relatives) {
  if (!profileId) return;

  // One entry per relative, even if the response repeats an id.
  const unique = new Map();
  for (const relative of relatives) {
    if (relative && relative.relative_profile_id) {
      unique.set(relative.relative_profile_id, relative);
    }
  }

  const list = [...unique.values()].sort(byIbdDescending);

  await db.profile_relatives.put({ profile_id: profileId, relatives: list });
}

// Stores the relatives in common for one profile + relative pair, keeping
// every field returned by the endpoint. One record per profile holds all of
// that profile's pairs.
export async function saveRelativesInCommon(profileId, relativeId, relatives) {
  if (!profileId || !relativeId) return;

  await db.transaction('rw', db.relatives_in_common, async () => {
    const record = await db.relatives_in_common.get(profileId);
    const pairs = record && Array.isArray(record.pairs) ? record.pairs : [];
    const others = pairs.filter((pair) => pair.relative_profile_id !== relativeId);

    others.push({ relative_profile_id: relativeId, relatives });
    await db.relatives_in_common.put({ profile_id: profileId, pairs: others });
  });
}

// Reads the saved DNA relatives list for one profile.
export async function getSavedRelatives(profileId) {
  if (!profileId) return [];

  const record = await db.profile_relatives.get(profileId);
  return record && Array.isArray(record.relatives) ? record.relatives : [];
}

// Reads every saved pair for one profile.
export async function getProfileRelativesInCommon(profileId) {
  if (!profileId) return [];

  const record = await db.relatives_in_common.get(profileId);
  return record && Array.isArray(record.pairs) ? record.pairs : [];
}

// Reads one pair's relatives in common.
export async function getRelativesInCommon(profileId, relativeId) {
  if (!profileId || !relativeId) return null;

  const record = await db.relatives_in_common.get(profileId);
  const pair = record && Array.isArray(record.pairs)
    ? record.pairs.find((item) => item.relative_profile_id === relativeId)
    : null;

  return pair ? pair.relatives : null;
}

// Deletes the whole local database, including its schema. A fresh, unopened
// Dexie instance is created so the next write recreates the database.
export async function deleteDatabase() {
  await db.delete();
  db = createDb();
}

/* ---------- JSON export / import ---------- */

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function profileIdOf(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

// Returns a plain object with every saved profile, its relatives, and its
// relatives-in-common pairs. Arrays are kept exactly as saved.
export async function exportDatabaseJson() {
  const [relativeRecords, commonRecords] = await Promise.all([
    db.profile_relatives.toArray(),
    db.relatives_in_common.toArray(),
  ]);

  const byProfile = new Map();

  function ensureProfile(profileId) {
    if (!byProfile.has(profileId)) {
      byProfile.set(profileId, { profile_id: profileId, relatives: [], pairs: [] });
    }
    return byProfile.get(profileId);
  }

  for (const record of relativeRecords) {
    const profileId = profileIdOf(record && record.profile_id);
    if (!profileId) continue;

    const profile = ensureProfile(profileId);
    if (Array.isArray(record.relatives)) profile.relatives = record.relatives;
  }

  for (const record of commonRecords) {
    const profileId = profileIdOf(record && record.profile_id);
    if (!profileId) continue;

    const profile = ensureProfile(profileId);
    if (Array.isArray(record.pairs)) profile.pairs = record.pairs;
  }

  const profiles = [...byProfile.values()].sort(
    (a, b) => a.profile_id.localeCompare(b.profile_id),
  );

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    profiles,
  };
}

// Streams the same JSON shape to a writer without building the whole file in
// memory. `write` receives a series of strings.
export async function exportDatabaseJsonStream(write) {
  if (typeof write !== 'function') {
    throw new Error('a write function is required');
  }

  const [relativeKeys, commonKeys] = await Promise.all([
    db.profile_relatives.toCollection().primaryKeys(),
    db.relatives_in_common.toCollection().primaryKeys(),
  ]);

  const keys = [...new Set([...relativeKeys, ...commonKeys])];
  keys.sort((a, b) => String(a).localeCompare(String(b)));

  let profiles = 0;
  let comparisons = 0;
  let relativeRows = 0;

  await write('{"format":' + JSON.stringify(EXPORT_FORMAT)
    + ',"version":' + EXPORT_VERSION
    + ',"exported_at":' + JSON.stringify(new Date().toISOString())
    + ',"profiles":[');

  let firstProfile = true;

  for (const key of keys) {
    const [relativeRecord, commonRecord] = await Promise.all([
      db.profile_relatives.get(key),
      db.relatives_in_common.get(key),
    ]);

    const relatives = relativeRecord && Array.isArray(relativeRecord.relatives)
      ? relativeRecord.relatives
      : [];
    const pairs = commonRecord && Array.isArray(commonRecord.pairs)
      ? commonRecord.pairs
      : [];

    if (!relativeRecord && !commonRecord) continue;

    if (!firstProfile) await write(',');
    firstProfile = false;

    await write('{"profile_id":' + JSON.stringify(String(key)) + ',"relatives":[');

    for (let index = 0; index < relatives.length; index++) {
      if (index > 0) await write(',');
      await write(JSON.stringify(relatives[index]));
    }

    await write('],"pairs":[');

    for (let index = 0; index < pairs.length; index++) {
      if (index > 0) await write(',');
      await write(JSON.stringify(pairs[index]));
    }

    await write(']}');

    profiles++;
    comparisons += pairs.length;
    relativeRows += relatives.length;
  }

  await write(']}');

  return { profiles, comparisons, relatives: relativeRows };
}

// Validates one profile from a parsed JSON export.
export function validateJsonProfile(profile, profileIndex = 0) {
  if (!isObject(profile)) {
    throw new Error('profile ' + (profileIndex + 1) + ' is not an object');
  }

  const profileId = profileIdOf(profile.profile_id);
  if (!profileId) {
    throw new Error('profile ' + (profileIndex + 1) + ' has no profile_id');
  }

  const relatives = profile.relatives === undefined ? [] : profile.relatives;
  if (!Array.isArray(relatives) || !relatives.every(isObject)) {
    throw new Error('profile ' + profileId + ' has an invalid relatives list');
  }

  const pairs = profile.pairs === undefined ? [] : profile.pairs;
  if (!Array.isArray(pairs)) {
    throw new Error('profile ' + profileId + ' has an invalid pairs list');
  }

  const normalizedPairs = pairs.map((pair, pairIndex) => {
    if (!isObject(pair)) {
      throw new Error('profile ' + profileId + ' pair ' + (pairIndex + 1) + ' is not an object');
    }

    const relativeId = profileIdOf(pair.relative_profile_id);
    if (!relativeId) {
      throw new Error('profile ' + profileId + ' pair ' + (pairIndex + 1) + ' has no relative_profile_id');
    }
    if (!Array.isArray(pair.relatives) || !pair.relatives.every(isObject)) {
      throw new Error('profile ' + profileId + ' pair ' + relativeId + ' has an invalid relatives list');
    }

    return { relative_profile_id: relativeId, relatives: pair.relatives };
  });

  return { profile_id: profileId, relatives, pairs: normalizedPairs };
}

// Validates a parsed JSON export before anything in IndexedDB is changed.
export function validateJsonExport(data) {
  if (!isObject(data)) {
    throw new Error('the file does not contain a JSON object');
  }
  if (data.format !== EXPORT_FORMAT) {
    throw new Error('this is not a Relatives in Common JSON export');
  }
  if (data.version !== EXPORT_VERSION) {
    throw new Error('this JSON export uses an unsupported version');
  }
  if (!Array.isArray(data.profiles)) {
    throw new Error('the export does not contain a profiles array');
  }

  const seen = new Set();
  let comparisons = 0;
  let relativeRows = 0;

  const profiles = data.profiles.map((profile, profileIndex) => {
    const normalized = validateJsonProfile(profile, profileIndex);
    if (seen.has(normalized.profile_id)) {
      throw new Error('profile_id ' + normalized.profile_id + ' appears more than once');
    }
    seen.add(normalized.profile_id);

    comparisons += normalized.pairs.length;
    relativeRows += normalized.relatives.length;
    return normalized;
  });

  return {
    profiles,
    counts: {
      profiles: profiles.length,
      comparisons,
      relatives: relativeRows,
    },
  };
}

// Clears both stores. Used by the streaming importer after the file has been
// validated.
export async function clearDatabaseData() {
  await db.transaction('rw', db.profile_relatives, db.relatives_in_common, async () => {
    await db.profile_relatives.clear();
    await db.relatives_in_common.clear();
  });
}

// Writes one validated profile from the streaming importer.
export async function writeImportedProfile(profile) {
  await db.transaction('rw', db.profile_relatives, db.relatives_in_common, async () => {
    await db.profile_relatives.put({
      profile_id: profile.profile_id,
      relatives: profile.relatives,
    });

    await db.relatives_in_common.put({
      profile_id: profile.profile_id,
      pairs: profile.pairs,
    });
  });
}

// Replaces both stores with a validated JSON export.
export async function importDatabaseJson(data) {
  const { profiles, counts } = validateJsonExport(data);

  await db.transaction('rw', db.profile_relatives, db.relatives_in_common, async () => {
    await db.profile_relatives.clear();
    await db.relatives_in_common.clear();

    if (profiles.length > 0) {
      await db.profile_relatives.bulkPut(profiles.map((profile) => ({
        profile_id: profile.profile_id,
        relatives: profile.relatives,
      })));

      await db.relatives_in_common.bulkPut(profiles.map((profile) => ({
        profile_id: profile.profile_id,
        pairs: profile.pairs,
      })));
    }
  });

  return counts;
}
