/*
 * Haplogroup helpers
 *
 * 23andMe's ancestry compute-result endpoint returns rows whose haplogroup_id is
 * "<build>:<id>", for example "phylotree_mtdna_build_7:C1b" or
 * "isogg_ydna_2016_01_04:R-P311". Only the id after the build prefix is shown.
 *
 * The endpoint accepts several profile ids in one request, so relatives can be
 * looked up in batches. Rows for the same haplogroup from different builds are
 * resolved by keeping the most recent one.
 */

const HAPLOGROUP_NAMES = 'mthaplo_build_7:haplogroup,yhaplo_2023:haplogroup';

function encodeIds(profileIds) {
  const ids = Array.isArray(profileIds) ? profileIds : [profileIds];
  return ids
    .filter((id) => id !== undefined && id !== null && String(id).trim())
    .map((id) => encodeURIComponent(String(id).trim()))
    .join('%2C');
}

export function haplogroupUrl(viewerProfileId, profileIds) {
  return 'https://you.23andme.com/p/' + encodeURIComponent(viewerProfileId)
    + '/ancestry/compute-result/?profile_id=' + encodeIds(profileIds)
    + '&name=' + encodeURIComponent(HAPLOGROUP_NAMES);
}

// "mthaplo_build_7:haplogroup" -> "maternal", "yhaplo_2023:haplogroup" ->
// "paternal". The build part is deliberately ignored so a later build still
// matches.
function kindOf(name) {
  const source = String(name || '').split(':')[0].trim().toLowerCase();
  if (source.startsWith('mthaplo')) return 'maternal';
  if (source.startsWith('yhaplo')) return 'paternal';
  return '';
}

export function haplogroupId(value) {
  if (value === undefined || value === null) return '';

  const text = String(value).trim();
  const colon = text.lastIndexOf(':');
  return (colon === -1 ? text : text.slice(colon + 1)).trim();
}

function normalizeId(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().toLowerCase();
}

function collect(payload, wanted) {
  const found = new Map();
  const rows = Array.isArray(payload) ? payload : [];

  for (const row of rows) {
    if (!row) continue;

    const profileId = normalizeId(row.profile_id);
    if (!profileId || !wanted.has(profileId)) continue;
    if (row.status && String(row.status).trim().toLowerCase() !== 'active') continue;

    const kind = kindOf(row.name);
    if (!kind) continue;

    const value = haplogroupId(row.result && row.result.haplogroup_id);
    if (!value) continue;

    let entry = found.get(profileId);
    if (!entry) {
      entry = { maternal: '', paternal: '', maternalTime: '', paternalTime: '' };
      found.set(profileId, entry);
    }

    const time = String(row.time_created || '');
    const timeKey = kind === 'maternal' ? 'maternalTime' : 'paternalTime';
    if (entry[kind] && time && entry[timeKey] && time < entry[timeKey]) continue;

    entry[kind] = value;
    entry[timeKey] = time;
  }

  return found;
}

export function pickHaplogroups(payload, profileId) {
  const id = normalizeId(profileId);
  const entry = collect(payload, new Set([id])).get(id);

  return entry
    ? { maternal: entry.maternal, paternal: entry.paternal }
    : { maternal: '', paternal: '' };
}

// Returns { [profileId]: { maternal, paternal } } for the requested ids that
// appear in the response.
export function pickHaplogroupMap(payload, profileIds) {
  const ids = (Array.isArray(profileIds) ? profileIds : [profileIds])
    .map(normalizeId)
    .filter(Boolean);
  const found = collect(payload, new Set(ids));
  const map = {};

  for (const id of ids) {
    const entry = found.get(id);
    if (!entry || (!entry.maternal && !entry.paternal)) continue;

    map[id] = { maternal: entry.maternal, paternal: entry.paternal };
  }

  return map;
}
