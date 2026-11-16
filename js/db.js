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
});

// The fields kept for each relative.
const RELATIVE_FIELDS = [
  'relative_profile_id',
  'first_name',
  'last_name',
  'initials',
  'ibd_proportion',
  'is_maternal_side',
  'is_paternal_side',
  'num_segments',
  'max_segment_length',
];

function relativeRecord(relative) {
  const record = {};
  for (const field of RELATIVE_FIELDS) {
    record[field] = relative[field] === undefined ? null : relative[field];
  }
  return record;
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
