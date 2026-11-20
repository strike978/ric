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
