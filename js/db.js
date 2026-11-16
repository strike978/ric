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
