/*
 * Shared DNA formatting
 *
 * 23andMe reports shared DNA as a proportion of the genome. Its cM scale is
 * about 74.4 cM per percentage point.
 */

export const CM_PER_PERCENT = 74.4;

export function numberValue(value) {
  if (value === undefined || value === null || value === '') return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Estimated cM for one proportion, or null when it is missing.
export function cmFromProportion(value) {
  const proportion = numberValue(value);
  if (proportion === null) return null;

  return Math.round(proportion * 100 * CM_PER_PERCENT);
}

// "3718 cM across 30 segments", or whichever part is available.
export function sharedDnaLabel(relative) {
  const cM = cmFromProportion(relative && relative.ibd_proportion);
  const segments = numberValue(relative && relative.num_segments);
  const parts = [];

  if (cM !== null) parts.push(cM + ' cM');
  if (segments !== null) parts.push(segments + (segments === 1 ? ' segment' : ' segments'));

  return parts.length ? parts.join(' across ') : '—';
}

// Every IBD column the row carries, e.g. [1, 2].
export function ibdIndices(row) {
  const indices = [];
  for (const key of Object.keys(row)) {
    const match = /^ibd_proportion_(\d+)$/.exec(key);
    if (match) indices.push(Number(match[1]));
  }
  indices.sort((a, b) => a - b);
  return indices;
}

// A common-match row carries one context for the profile and one for the
// compared relative. The compared relative's own saved proportion identifies
// which column belongs to the profile. Returns that index, or null when the
// row cannot be trusted.
export function ownerIndexEvidence(row, ownerPerson) {
  const indices = ibdIndices(row);
  if (indices.length < 2) return null;

  const ownerProportion = numberValue(ownerPerson && ownerPerson.ibd_proportion);
  if (ownerProportion === null) return null;

  const tolerance = Math.max(0.0025, Math.abs(ownerProportion) * 0.02);
  let closest = null;
  for (const index of indices) {
    const value = numberValue(row['ibd_proportion_' + index]);
    if (value === null) continue;

    const distance = Math.abs(value - ownerProportion);
    if (!closest || distance < closest.distance) {
      closest = { index, distance };
    }
  }

  return closest && closest.distance <= tolerance ? closest.index : null;
}

// The row for one common match is written from the compared relative's side.
// Mirroring it into the common match's own pair swaps the contexts: the
// profile side becomes the fetched relative, and the other side stays the
// sharing between the two relatives.
export function mirroredCommonRelative(fetchedRelative, comparedRelative, row) {
  if (!fetchedRelative || !comparedRelative || !row) return null;

  const fetchedId = String(fetchedRelative.relative_profile_id || '').trim();
  const comparedId = String(comparedRelative.relative_profile_id || '').trim();
  if (!fetchedId || !comparedId || fetchedId === comparedId) return null;

  const ownerIndex = ownerIndexEvidence(row, comparedRelative);
  if (ownerIndex === null) return null;

  let peerIndex = null;
  for (const index of ibdIndices(row)) {
    if (index === ownerIndex) continue;

    const value = numberValue(row['ibd_proportion_' + index]);
    if (value === null || value <= 0) continue;

    if (peerIndex === null
      || value > numberValue(row['ibd_proportion_' + peerIndex])) {
      peerIndex = index;
    }
  }
  if (peerIndex === null) return null;

  return {
    profile_id: fetchedId,
    first_name: fetchedRelative.first_name,
    last_name: fetchedRelative.last_name,
    first_initial: fetchedRelative.first_initial,
    last_initial: fetchedRelative.last_initial,
    initials: fetchedRelative.initials,
    sex: fetchedRelative.sex,
    profile_image_url: fetchedRelative.profile_image_url,
    is_open_sharing: fetchedRelative.is_open_sharing,
    ibd_proportion_1: fetchedRelative.ibd_proportion,
    num_segments_1: fetchedRelative.num_segments,
    predicted_relationship_id_1: fetchedRelative.predicted_relationship_id,
    ibd_proportion_2: row['ibd_proportion_' + peerIndex],
    num_segments_2: row['num_segments_' + peerIndex],
    predicted_relationship_id_2: row['predicted_relationship_id_' + peerIndex],
    derived: true,
  };
}
