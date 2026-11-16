/*
 * Relative storage
 *
 * IndexedDB via Dexie. Each selected profile gets one record keyed by its
 * profile id, holding that profile's relatives as an array sorted by IBD
 * proportion. Loading a profile again replaces its record.
 *
 * The database is a development cache with a single schema version.
 */

import Dexie from '../vendor/dexie.mjs';

const db = new Dexie('relatives-in-common');

db.version(1).stores({
  profiles: 'profile_id',
  comparisons: 'profile_id',
});

function relativeRecord(relative) {
  return { ...relative };
}

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

  const list = [...unique.values()]
    .map(relativeRecord)
    .sort(byIbdDescending);

  await db.profiles.put({ profile_id: profileId, relatives: list });
}

// Reads one profile's relatives, highest IBD proportion first.
export async function getRelatives(profileId) {
  if (!profileId) return [];
  const record = await db.profiles.get(profileId);
  return record && Array.isArray(record.relatives)
    ? record.relatives.sort(byIbdDescending)
    : [];
}

// Stores the relatives-in-common entries for one profile + relative pair,
// keeping every field returned by the endpoint. One record per profile holds
// all of that profile's comparisons.
export async function saveComparison(profileId, relativeId, entries) {
  if (!profileId || !relativeId) return;

  await db.transaction('rw', db.comparisons, async () => {
    const record = await db.comparisons.get(profileId);
    const list = record && Array.isArray(record.comparisons) ? record.comparisons : [];
    const others = list.filter((item) => item.relative_profile_id !== relativeId);

    others.push({ relative_profile_id: relativeId, entries });
    await db.comparisons.put({ profile_id: profileId, comparisons: others });
  });
}

// Reads one pair's relatives-in-common entries.
export async function getComparison(profileId, relativeId) {
  if (!profileId || !relativeId) return null;

  const record = await db.comparisons.get(profileId);
  const match = record && Array.isArray(record.comparisons)
    ? record.comparisons.find((item) => item.relative_profile_id === relativeId)
    : null;

  return match ? match.entries : null;
}
