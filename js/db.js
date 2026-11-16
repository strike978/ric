/*
 * Relative storage
 *
 * IndexedDB via Dexie. A loaded relatives list is stored per selected profile,
 * keyed by (profile_id, relative_profile_id), so loading a profile again
 * replaces its previous rows.
 */

import Dexie from '../vendor/dexie.mjs';

const db = new Dexie('relatives-in-common');

db.version(1).stores({
  // Compound primary key identifies one relative within one profile.
  // profile_id is indexed so a profile's rows can be read or replaced in one go.
  relatives: '[profile_id+relative_profile_id], profile_id',
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

function recordFor(profileId, relative) {
  const record = { profile_id: profileId };
  for (const field of RELATIVE_FIELDS) {
    record[field] = relative[field] === undefined ? null : relative[field];
  }
  return record;
}

// Replaces the stored relatives for one profile.
export async function saveRelatives(profileId, relatives) {
  if (!profileId) return;

  const records = relatives
    .filter((relative) => relative && relative.relative_profile_id)
    .map((relative) => recordFor(profileId, relative));

  await db.transaction('rw', db.relatives, async () => {
    await db.relatives.where('profile_id').equals(profileId).delete();
    if (records.length > 0) await db.relatives.bulkPut(records);
  });
}

// Reads the stored relatives for one profile.
export async function getRelatives(profileId) {
  if (!profileId) return [];
  return db.relatives.where('profile_id').equals(profileId).toArray();
}
