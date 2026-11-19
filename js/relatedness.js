/*
 * DNA relatedness model
 *
 * Builds a graph of the selected profile and its saved relatives from the data
 * already fetched by the main page:
 *
 *   profile_relatives[owner]        owner -> relative relationships
 *   relatives_in_common[owner][X]   people shared by the owner and relative X
 *
 * A relatives-in-common row for a shared match Y has a predicted relationship
 * and IBD proportion on both sides: one for the owner and one for X.
 * The owner side is found by matching those values against the owner's saved
 * relatives list; if that list is unavailable, it is the column that stays
 * stable for the same shared match across pairs. The X side then becomes a
 * direct X <-> Y link.
 *
 * No DOM and no database access, so this module can be tested on its own.
 */

export function numberValue(value) {
  if (value === undefined || value === null || value === '') return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function idOf(value) {
  return value === undefined || value === null ? '' : String(value);
}

export function pairKey(aId, bId) {
  const a = idOf(aId);
  const b = idOf(bId);
  return a < b ? a + '\u0000' + b : b + '\u0000' + a;
}

function textValue(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

// Shared-match rows use profile_id, but accept relative_profile_id too so the
// model still works if a different export shape is loaded later.
function sharedIdOf(record) {
  if (!record) return '';

  const profileId = idOf(record.profile_id);
  if (profileId) return profileId;

  return idOf(record.relative_profile_id);
}

function firstNumber(record, keys) {
  if (!record) return null;

  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== null) return value;
  }

  return null;
}

// Segment counts on the main relatives list use an unindexed field.
function directSegmentsOf(record) {
  return firstNumber(record, [
    'num_segments',
    'ibd_segments',
    'segments',
    'segment_count',
    'segments_count',
    'num_ibd_segments',
  ]);
}

// Shared-match rows use numbered segment fields, one per side.
function commonSegmentsOf(record, index) {
  return firstNumber(record, [
    'num_segments_' + index,
    'ibd_segments_' + index,
    'segments_' + index,
    'segment_count_' + index,
    'segments_count_' + index,
    'num_ibd_segments_' + index,
  ]);
}

function normalizeRelationship(value) {
  return textValue(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Every Rel N / IBD N pair present on a shared-match row.
function recordIndexes(record) {
  const indexes = new Set();

  for (const key of Object.keys(record || {})) {
    const match = /^(?:predicted_relationship_id|ibd_proportion)_(\d+)$/.exec(key);
    if (match) indexes.add(Number(match[1]));
  }

  return [...indexes].sort((a, b) => a - b);
}

// Positive when the indexed side looks like the owner: the IBD
// proportion should agree with the owner's saved relative row, and the
// relationship label should match too.
function ownerMatchScore(record, index, ownerRecord) {
  let score = 0;
  let signals = 0;

  const ownerIbd = numberValue(ownerRecord && ownerRecord.ibd_proportion);
  const recordIbd = numberValue(record['ibd_proportion_' + index]);

  if (ownerIbd !== null && recordIbd !== null) {
    const difference = Math.abs(ownerIbd - recordIbd);
    if (difference <= 0.002) score += 2;
    else if (difference <= 0.01) score += 1;
    else score -= 1;
    signals++;
  }

  const ownerRelation = normalizeRelationship(ownerRecord && ownerRecord.predicted_relationship_id);
  const recordRelation = normalizeRelationship(record['predicted_relationship_id_' + index]);

  if (ownerRelation && recordRelation) {
    if (ownerRelation === recordRelation) score += 2;
    else score -= 0.5;
    signals++;
  }

  const ownerSegments = directSegmentsOf(ownerRecord);
  const recordSegments = commonSegmentsOf(record, index);

  if (ownerSegments !== null && recordSegments !== null) {
    if (ownerSegments === recordSegments) score += 1;
    else score -= 0.5;
    signals++;
  }

  return signals ? score : null;
}

// Fallback orientation when the owner's saved relative rows are missing: the
// owner side of each shared match should stay stable from pair to pair, while
// the compared relative's side changes. Choose the column with the smallest
// spread for repeated shared matches.
function detectConsistentOwnerIndex(pairs) {
  const valuesById = new Map();

  for (const pair of pairs) {
    for (const record of pair.relatives) {
      const id = sharedIdOf(record);
      if (!id) continue;

      if (!valuesById.has(id)) valuesById.set(id, new Map());
      const byIndex = valuesById.get(id);

      for (const index of recordIndexes(record)) {
        const value = numberValue(record['ibd_proportion_' + index]);
        if (value === null) continue;

        if (!byIndex.has(index)) byIndex.set(index, []);
        byIndex.get(index).push(value);
      }
    }
  }

  const totals = new Map();
  const counts = new Map();

  for (const byIndex of valuesById.values()) {
    for (const [index, values] of byIndex) {
      if (values.length < 2) continue;

      const spread = Math.max(...values) - Math.min(...values);
      totals.set(index, (totals.get(index) || 0) + spread);
      counts.set(index, (counts.get(index) || 0) + 1);
    }
  }

  let best = 1;
  let bestSpread = Infinity;

  for (const [index, total] of totals) {
    const average = total / counts.get(index);
    if (average < bestSpread || (average === bestSpread && index < best)) {
      best = index;
      bestSpread = average;
    }
  }

  return best;
}

// Chooses the shared-match column that belongs to the owner across all pairs.
function detectGlobalOwnerIndex(pairs, relativesById) {
  const totals = new Map();

  for (const pair of pairs) {
    for (const record of pair.relatives) {
      const ownerRecord = relativesById.get(sharedIdOf(record));
      if (!ownerRecord) continue;

      for (const index of recordIndexes(record)) {
        const score = ownerMatchScore(record, index, ownerRecord);
        if (score === null) continue;

        totals.set(index, (totals.get(index) || 0) + score);
      }
    }
  }

  if (totals.size === 0) return detectConsistentOwnerIndex(pairs);

  let best = 1;
  let bestScore = -Infinity;

  for (const [index, score] of totals) {
    if (score > bestScore || (score === bestScore && index < best)) {
      best = index;
      bestScore = score;
    }
  }

  return best;
}

// Per-pair refinement. Most pairs agree with the global index, but a pair can
// occasionally come back in the other order.
function detectPairOwnerIndex(pair, relativesById, fallback) {
  const totals = new Map();

  for (const record of pair.relatives) {
    const ownerRecord = relativesById.get(sharedIdOf(record));
    if (!ownerRecord) continue;

    for (const index of recordIndexes(record)) {
      const score = ownerMatchScore(record, index, ownerRecord);
      if (score === null) continue;

      totals.set(index, (totals.get(index) || 0) + score);
    }
  }

  let best = fallback;
  let bestScore = -Infinity;

  for (const [index, score] of totals) {
    if (score > bestScore || (score === bestScore && index === fallback)) {
      best = index;
      bestScore = score;
    }
  }

  return best;
}

// Splits one shared-match row into its owner side and its compared-relative
// side. Handles rows that only carry one side.
function recordSides(record, pairOwnerIndex, ownerRecord) {
  const indexes = recordIndexes(record);
  if (indexes.length === 0) return null;

  if (indexes.includes(pairOwnerIndex)) {
    return {
      ownerIndex: pairOwnerIndex,
      otherIndexes: indexes.filter((index) => index !== pairOwnerIndex),
    };
  }

  if (indexes.length >= 2) {
    let best = indexes[0];
    let bestScore = -Infinity;

    if (ownerRecord) {
      for (const index of indexes) {
        const score = ownerMatchScore(record, index, ownerRecord);
        if (score !== null && score > bestScore) {
          best = index;
          bestScore = score;
        }
      }
    }

    return {
      ownerIndex: best,
      otherIndexes: indexes.filter((index) => index !== best),
    };
  }

  // A single side. If it looks like the owner, keep it as the owner side;
  // otherwise it can still describe the compared relative.
  const score = ownerRecord ? ownerMatchScore(record, indexes[0], ownerRecord) : null;

  if (score !== null && score > 0) {
    return { ownerIndex: indexes[0], otherIndexes: [] };
  }

  return { ownerIndex: null, otherIndexes: [indexes[0]] };
}

// More than two columns is unusual, but use the strongest one as the compared
// relative rather than guessing by position.
function primaryOtherIndex(record, otherIndexes) {
  if (otherIndexes.length === 0) return null;
  if (otherIndexes.length === 1) return otherIndexes[0];

  let best = otherIndexes[0];
  let bestValue = numberValue(record['ibd_proportion_' + best]);

  for (const index of otherIndexes.slice(1)) {
    const value = numberValue(record['ibd_proportion_' + index]);
    if (value !== null && (bestValue === null || value > bestValue)) {
      best = index;
      bestValue = value;
    }
  }

  return best;
}

function sideValues(record, index) {
  if (index === null || index === undefined) {
    return { proportion: null, segments: null, relationship: '' };
  }

  return {
    proportion: numberValue(record['ibd_proportion_' + index]),
    segments: commonSegmentsOf(record, index),
    relationship: textValue(record['predicted_relationship_id_' + index]),
  };
}

function mergePerson(person, data) {
  if (!data || typeof data !== 'object') return person;

  for (const key of [
    'first_name',
    'last_name',
    'first_initial',
    'last_initial',
    'initials',
    'sex',
    'profile_image_url',
  ]) {
    if (!person[key] && data[key]) person[key] = data[key];
  }

  return person;
}

function addObservation(edges, aId, bId, observation) {
  if (!aId || !bId || aId === bId) return;

  const proportion = numberValue(observation.proportion);
  const segments = numberValue(observation.segments);
  const relationship = textValue(observation.relationship);

  if (proportion === null && segments === null && !relationship) return;

  const key = pairKey(aId, bId);
  let edge = edges.get(key);

  if (!edge) {
    edge = {
      key,
      a: aId < bId ? aId : bId,
      b: aId < bId ? bId : aId,
      values: [],
      segmentValues: [],
      relationships: new Map(),
      observations: 0,
      sources: new Set(),
      direct: false,
    };
    edges.set(key, edge);
  }

  if (proportion !== null) edge.values.push(proportion);
  if (segments !== null) edge.segmentValues.push(segments);

  if (relationship) {
    const observer = idOf(observation.observer);
    const subject = idOf(observation.subject);

    if ((observer === edge.a && subject === edge.b) || (observer === edge.b && subject === edge.a)) {
      edge.relationships.set(observer, { observer, subject, label: relationship });
    }
  }

  if (observation.source) edge.sources.add(observation.source);
  if (observation.direct) edge.direct = true;

  edge.observations++;
}

function unionFind(ids) {
  const parent = new Map(ids.map((id) => [id, id]));
  const rank = new Map(ids.map((id) => [id, 0]));

  function find(id) {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);

    let current = id;
    while (parent.get(current) !== current) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }

    return root;
  }

  function union(a, b) {
    let rootA = find(a);
    let rootB = find(b);
    if (rootA === rootB) return;

    if ((rank.get(rootA) || 0) < (rank.get(rootB) || 0)) {
      [rootA, rootB] = [rootB, rootA];
    }

    parent.set(rootB, rootA);

    if (rank.get(rootA) === rank.get(rootB)) {
      rank.set(rootA, (rank.get(rootA) || 0) + 1);
    }
  }

  return { find, union };
}

const DEFAULT_MIN_OVERLAP = 3;
const MAX_OVERLAP_PEOPLE = 2500;
const MAX_TRACKED_OVERLAP = 65535;

// Count how many shared matches each pair of relatives has in common. The
// counts array is flat because the number of pair relatives is bounded for a
// browser page. Every saved shared pair is used; the threshold decides how
// much overlap is needed to join a group.
function buildOverlapData(normalizedPairs, owner, ids) {
  const n = ids.length;

  if (n < 2 || n > MAX_OVERLAP_PEOPLE) {
    return { available: false, ids, n, counts: null, keys: [] };
  }

  const indexById = new Map(ids.map((id, index) => [id, index]));
  const sharedToRelatives = new Map();
  // stored on the returned overlap data for quick lookups in the UI

  for (const pair of normalizedPairs) {
    const relativeId = pair.relativeId;
    if (!indexById.has(relativeId)) continue;

    for (const record of pair.relatives) {
      const sharedId = sharedIdOf(record);
      if (!sharedId || sharedId === owner || sharedId === relativeId) continue;

      let relatives = sharedToRelatives.get(sharedId);
      if (!relatives) {
        relatives = new Set();
        sharedToRelatives.set(sharedId, relatives);
      }
      relatives.add(relativeId);
    }
  }

  const counts = new Uint16Array(n * n);

  for (const relatives of sharedToRelatives.values()) {
    if (relatives.size < 2) continue;

    const indexes = [...relatives].map((id) => indexById.get(id));

    for (let i = 0; i < indexes.length; i++) {
      for (let j = i + 1; j < indexes.length; j++) {
        let a = indexes[i];
        let b = indexes[j];
        if (a > b) {
          const swap = a;
          a = b;
          b = swap;
        }

        const key = a * n + b;
        if (counts[key] < MAX_TRACKED_OVERLAP) counts[key]++;
      }
    }
  }

  const keys = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const key = i * n + j;
      if (counts[key] >= 2) keys.push(key);
    }
  }

  return { available: true, ids, n, counts, keys, indexById };
}

function clusterGroups(groups, peopleById) {
  const clusters = [];

  for (const members of groups) {
    if (members.length < 2) continue;

    members.sort((a, b) => {
      const personA = peopleById.get(a);
      const personB = peopleById.get(b);
      const proportionA = personA && personA.directProportion !== null ? personA.directProportion : -1;
      const proportionB = personB && personB.directProportion !== null ? personB.directProportion : -1;
      return proportionB - proportionA || a.localeCompare(b);
    });

    clusters.push({ members, anchorId: members[0] });
  }

  clusters.sort((a, b) => {
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;

    const personA = peopleById.get(a.anchorId);
    const personB = peopleById.get(b.anchorId);
    const proportionA = personA && personA.directProportion !== null ? personA.directProportion : -1;
    const proportionB = personB && personB.directProportion !== null ? personB.directProportion : -1;
    return proportionB - proportionA || a.anchorId.localeCompare(b.anchorId);
  });

  const clustersById = new Map();

  clusters.forEach((cluster, position) => {
    cluster.id = 'c' + (position + 1);
    cluster.index = position + 1;
    clustersById.set(cluster.id, cluster);
  });

  return { clusters, clustersById };
}

function sortPeople(model) {
  model.people.sort((a, b) => {
    if (a.isOwner) return -1;
    if (b.isOwner) return 1;

    const clusterA = a.cluster ? model.clustersById.get(a.cluster) : null;
    const clusterB = b.cluster ? model.clustersById.get(b.cluster) : null;
    const indexA = clusterA ? clusterA.index : Infinity;
    const indexB = clusterB ? clusterB.index : Infinity;

    if (indexA !== indexB) return indexA - indexB;

    const proportionA = a.directProportion === null ? -1 : a.directProportion;
    const proportionB = b.directProportion === null ? -1 : b.directProportion;
    return proportionB - proportionA || a.id.localeCompare(b.id);
  });
}

function applyClusters(model, clusters, clustersById) {
  for (const person of model.people) {
    person.cluster = null;
    person.clusterIndex = undefined;
  }

  for (const cluster of clusters) {
    for (const id of cluster.members) {
      const person = model.peopleById.get(id);
      if (!person) continue;
      person.cluster = cluster.id;
      person.clusterIndex = cluster.index;
    }
  }

  model.clusters = clusters;
  model.clustersById = clustersById;
  model.stats.clusterCount = clusters.length;
  model.stats.largestCluster = clusters.length ? clusters[0].members.length : 0;
  model.stats.networkPeople = clusters.reduce(
    (total, cluster) => total + cluster.members.length,
    0,
  );

  sortPeople(model);
}

function directGroupsForModel(model) {
  const ids = model.people.filter((person) => !person.isOwner).map((person) => person.id);
  const idSet = new Set(ids);
  const union = unionFind(ids);

  for (const edge of model.networkEdges) {
    if (idSet.has(edge.a) && idSet.has(edge.b)) union.union(edge.a, edge.b);
  }

  const groups = new Map();

  for (const id of ids) {
    const root = union.find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }

  return groups;
}

// Number of shared matches two relatives have in common, if both have a saved
// pair list. Zero means no overlap; null means one side has no pair data.
export function sharedMatchOverlap(model, aId, bId) {
  const overlap = model && model.overlap;

  if (!overlap || !overlap.available || !overlap.indexById) return null;

  const a = overlap.indexById.get(idOf(aId));
  const b = overlap.indexById.get(idOf(bId));

  if (a === undefined || b === undefined || a === b) return null;

  const i = a < b ? a : b;
  const j = a < b ? b : a;
  return overlap.counts[i * overlap.n + j] || 0;
}

// Rebuilds the family groups without recomputing the shared-match overlap
// counts. Call this when the user changes the minimum overlap.
export function applyOverlapClusters(model, minOverlap = DEFAULT_MIN_OVERLAP) {
  const overlap = model.overlap;
  const threshold = Math.max(2, Number(minOverlap) || DEFAULT_MIN_OVERLAP);

  if (!overlap || !overlap.available) {
    const groups = directGroupsForModel(model);
    const { clusters, clustersById } = clusterGroups(groups.values(), model.peopleById);
    applyClusters(model, clusters, clustersById);
    model.minOverlap = null;
    model.stats.overlapAvailable = false;
    return model;
  }

  const union = unionFind(overlap.ids);

  for (const key of overlap.keys) {
    if (overlap.counts[key] < threshold) continue;

    const i = Math.floor(key / overlap.n);
    const j = key % overlap.n;
    union.union(overlap.ids[i], overlap.ids[j]);
  }

  const groups = new Map();

  for (const id of overlap.ids) {
    const root = union.find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }

  const { clusters, clustersById } = clusterGroups(groups.values(), model.peopleById);
  applyClusters(model, clusters, clustersById);
  model.minOverlap = threshold;
  model.stats.overlapAvailable = true;
  return model;
}

export function buildRelatednessModel({
  ownerId,
  relatives = [],
  pairs = [],
  minOverlap = DEFAULT_MIN_OVERLAP,
}) {
  const owner = idOf(ownerId);
  const people = new Map();
  const relativesById = new Map();
  const direct = new Map();
  const candidates = new Map();
  const edges = new Map();

  function ensurePerson(id, data) {
    const personId = idOf(id);
    if (!personId) return null;

    let person = people.get(personId);
    if (!person) {
      person = { id: personId };
      people.set(personId, person);
    }

    return mergePerson(person, data);
  }

  const ownerPerson = ensurePerson(owner, {});
  if (ownerPerson) {
    ownerPerson.isOwner = true;
    ownerPerson.first_name = 'You';
  }

  // Direct owner -> relative rows.
  for (const relative of relatives) {
    const relativeId = idOf(relative && relative.relative_profile_id);
    if (!relativeId || relativeId === owner) continue;

    relativesById.set(relativeId, relative);
    ensurePerson(relativeId, relative);

    direct.set(relativeId, {
      proportion: numberValue(relative.ibd_proportion),
      segments: directSegmentsOf(relative),
      relationship: textValue(relative.predicted_relationship_id),
    });
  }

  const normalizedPairs = [];

  for (const pair of pairs) {
    const relativeId = idOf(pair && pair.relative_profile_id);
    if (!relativeId || relativeId === owner) continue;

    const list = Array.isArray(pair.relatives)
      ? pair.relatives.filter((record) => record && typeof record === 'object')
      : [];

    normalizedPairs.push({ relativeId, relatives: list });
    ensurePerson(relativeId, {});
  }

  const globalOwnerIndex = detectGlobalOwnerIndex(normalizedPairs, relativesById);
  const pairOwnerIndexes = new Map();

  // Owner side of the shared-match rows also fills gaps in the direct list
  // and gives nodes to shared matches that were not in the saved relatives list.
  for (const pair of normalizedPairs) {
    const relativeId = pair.relativeId;
    const ownerIndex = detectPairOwnerIndex(pair, relativesById, globalOwnerIndex);
    pairOwnerIndexes.set(relativeId, ownerIndex);

    for (const record of pair.relatives) {
      const sharedId = sharedIdOf(record);
      if (!sharedId || sharedId === owner || sharedId === relativeId) continue;

      ensurePerson(sharedId, record);

      const ownerRecord = relativesById.get(sharedId);
      const sides = recordSides(record, ownerIndex, ownerRecord);
      if (!sides) continue;

      const ownerSide = sideValues(record, sides.ownerIndex);
      const otherIndex = primaryOtherIndex(record, sides.otherIndexes);
      const otherSide = sideValues(record, otherIndex);

      if (sides.ownerIndex !== null) {
        if (direct.has(sharedId)) {
          const existing = direct.get(sharedId);
          if (existing.proportion === null && ownerSide.proportion !== null) {
            existing.proportion = ownerSide.proportion;
          }
          if (existing.segments === null && ownerSide.segments !== null) {
            existing.segments = ownerSide.segments;
          }
          if (!existing.relationship && ownerSide.relationship) {
            existing.relationship = ownerSide.relationship;
          }
        } else {
          const previous = candidates.get(sharedId);
          const score = ownerSide.proportion !== null
            ? ownerSide.proportion
            : ownerSide.segments !== null ? ownerSide.segments / 1000 : -1;
          const previousScore = previous
            ? previous.proportion !== null
              ? previous.proportion
              : previous.segments !== null ? previous.segments / 1000 : -1
            : -1;

          if (!previous || score > previousScore) {
            candidates.set(sharedId, {
              proportion: ownerSide.proportion,
              segments: ownerSide.segments,
              relationship: ownerSide.relationship,
            });
          }
        }
      }

      // The compared relative's side becomes a direct relative <-> relative
      // link. The relationship label describes the shared match's relationship
      // to the compared relative.
      if (otherIndex !== null) {
        addObservation(edges, relativeId, sharedId, {
          proportion: otherSide.proportion,
          segments: otherSide.segments,
          relationship: otherSide.relationship,
          observer: relativeId,
          subject: sharedId,
          source: 'pair:' + relativeId,
        });
      }
    }
  }

  for (const [id, info] of candidates) {
    if (direct.has(id)) continue;
    direct.set(id, info);
  }

  // Owner edges come last so every gap filled above is included exactly once.
  for (const [id, info] of direct) {
    if (id === owner) continue;

    addObservation(edges, owner, id, {
      proportion: info.proportion,
      segments: info.segments,
      relationship: info.relationship,
      observer: owner,
      subject: id,
      direct: true,
      source: 'saved:owner',
    });
  }

  const edgeList = [...edges.values()];

  for (const edge of edgeList) {
    edge.proportion = edge.values.length ? Math.max(...edge.values) : null;
    edge.segments = edge.segmentValues.length ? Math.max(...edge.segmentValues) : null;
    edge.relationships = [...edge.relationships.values()];
    delete edge.values;
    delete edge.segmentValues;
  }

  // Person properties used by the matrix and network views.
  for (const [id, person] of people) {
    if (id === owner) {
      person.directProportion = null;
      person.directSegments = null;
      person.directRelationship = '';
      person.degree = 0;
      person.cluster = null;
      continue;
    }

    const info = direct.get(id);
    person.directProportion = info ? info.proportion : null;
    person.directSegments = info ? info.segments : null;
    person.directRelationship = info ? info.relationship : '';
    person.degree = 0;
    person.cluster = null;
  }

  // Networks are relative-to-relative links. The owner is deliberately left
  // out: the owner is related to everyone directly, which would merge every
  // family group into one.
  const nonOwnerIds = [...people.keys()].filter((id) => id !== owner);
  const adjacency = new Map(nonOwnerIds.map((id) => [id, new Set()]));
  const networkEdges = [];

  for (const edge of edgeList) {
    if (edge.a === owner || edge.b === owner) continue;
    if (edge.proportion === null && edge.segments === null && edge.relationships.length === 0) continue;

    networkEdges.push(edge);
    if (adjacency.has(edge.a)) adjacency.get(edge.a).add(edge.b);
    if (adjacency.has(edge.b)) adjacency.get(edge.b).add(edge.a);
  }

  for (const id of nonOwnerIds) {
    const person = people.get(id);
    if (person) person.degree = adjacency.get(id) ? adjacency.get(id).size : 0;
  }

  // Only relatives that have their own relatives-in-common list can take part
  // in overlap clustering. Clusters are based on how many shared matches two
  // relatives have in common, not on a single weak link.
  const overlapIds = [];
  const seenOverlap = new Set();

  for (const pair of normalizedPairs) {
    if (seenOverlap.has(pair.relativeId)) continue;
    seenOverlap.add(pair.relativeId);
    overlapIds.push(pair.relativeId);
  }

  const overlap = buildOverlapData(normalizedPairs, owner, overlapIds);

  const totalSharedRecords = normalizedPairs.reduce(
    (total, pair) => total + pair.relatives.length,
    0,
  );

  const segmentValues = edgeList
    .map((edge) => edge.segments)
    .filter((value) => value !== null);

  const stats = {
    totalPeople: people.size,
    relativeCount: relativesById.size,
    extraPeople: Math.max(0, people.size - 1 - relativesById.size),
    savedPairs: normalizedPairs.length,
    comparedRelatives: new Set(normalizedPairs.map((pair) => pair.relativeId)).size,
    totalSharedRecords,
    networkEdges: networkEdges.length,
    networkPeople: 0,
    clusterCount: 0,
    largestCluster: 0,
    directRelatives: [...direct.keys()].length,
    maxSegments: segmentValues.length ? Math.max(...segmentValues) : 0,
    hasSegments: segmentValues.length > 0,
    overlapAvailable: overlap.available,
    overlapPeople: overlapIds.length,
    overlapPairs: overlap.keys ? overlap.keys.length : 0,
    minOverlap: null,
  };

  const model = {
    ownerId: owner,
    people: [...people.values()],
    peopleById: people,
    relativesById,
    edges: edgeList,
    edgesByKey: edges,
    networkEdges,
    clusters: [],
    clustersById: new Map(),
    overlap,
    pairOwnerIndexes,
    pairsByRelativeId: new Map(normalizedPairs.map((pair) => [pair.relativeId, {
      ...pair,
      ownerIndex: pairOwnerIndexes.get(pair.relativeId),
    }])),
    stats,
  };

  applyOverlapClusters(model, minOverlap);
  return model;
}

// The relationship label for the column person relative to the row person:
// "column is row's <label>".
export function relationshipOf(edge, fromId, toId) {
  if (!edge || !Array.isArray(edge.relationships)) return '';

  const from = idOf(fromId);
  const to = idOf(toId);
  const match = edge.relationships.find(
    (item) => item.observer === from && item.subject === to,
  );

  return match ? match.label : '';
}

function matchResult(record, person, relToA, ibdToA, segmentsToA, relToB, ibdToB, segmentsToB) {
  return {
    id: person ? person.id : sharedIdOf(record),
    person,
    relToA,
    ibdToA,
    segmentsToA,
    relToB,
    ibdToB,
    segmentsToB,
  };
}

function sortSharedMatches(matches) {
  matches.sort((left, right) => {
    const leftProportion = Math.max(left.ibdToA ?? -1, left.ibdToB ?? -1);
    const rightProportion = Math.max(right.ibdToA ?? -1, right.ibdToB ?? -1);
    if (leftProportion !== rightProportion) return rightProportion - leftProportion;

    const leftSegments = Math.max(left.segmentsToA ?? -1, left.segmentsToB ?? -1);
    const rightSegments = Math.max(right.segmentsToA ?? -1, right.segmentsToB ?? -1);
    if (leftSegments !== rightSegments) return rightSegments - leftSegments;

    return left.id.localeCompare(right.id);
  });

  return matches;
}

// Shared matches between two people, as seen through the saved
// relatives-in-common lists. For the owner this is the pair's saved list; for
// two relatives it is the intersection of both lists.
export function sharedMatches(model, aId, bId) {
  const a = idOf(aId);
  const b = idOf(bId);
  const owner = model.ownerId;

  if (!a || !b || a === b) {
    return { available: false, reason: 'same-person', missingIds: [], matches: [] };
  }

  const aIsOwner = a === owner;
  const bIsOwner = b === owner;

  if (aIsOwner || bIsOwner) {
    const otherId = aIsOwner ? b : a;
    const pair = model.pairsByRelativeId.get(otherId);

    if (!pair) {
      return { available: false, reason: 'missing-pair', missingIds: [otherId], matches: [] };
    }

    const matches = [];

    for (const record of pair.relatives) {
      const id = sharedIdOf(record);
      if (!id || id === owner || id === otherId) continue;

      const ownerRecord = model.relativesById.get(id);
      const sides = recordSides(record, pair.ownerIndex, ownerRecord);
      if (!sides) continue;

      const ownerSide = sideValues(record, sides.ownerIndex);
      const otherIndex = primaryOtherIndex(record, sides.otherIndexes);
      const otherSide = sideValues(record, otherIndex);

      const relToOwner = ownerSide.relationship;
      const ibdToOwner = ownerSide.proportion;
      const segmentsToOwner = ownerSide.segments;
      const relToOther = otherSide.relationship;
      const ibdToOther = otherSide.proportion;
      const segmentsToOther = otherSide.segments;

      matches.push(matchResult(
        record,
        model.peopleById.get(id),
        aIsOwner ? relToOwner : relToOther,
        aIsOwner ? ibdToOwner : ibdToOther,
        aIsOwner ? segmentsToOwner : segmentsToOther,
        aIsOwner ? relToOther : relToOwner,
        aIsOwner ? ibdToOther : ibdToOwner,
        aIsOwner ? segmentsToOther : segmentsToOwner,
      ));
    }

    sortSharedMatches(matches);

    return { available: true, reason: '', missingIds: [], matches };
  }

  const pairA = model.pairsByRelativeId.get(a);
  const pairB = model.pairsByRelativeId.get(b);
  const missingIds = [];

  if (!pairA) missingIds.push(a);
  if (!pairB) missingIds.push(b);

  if (missingIds.length > 0) {
    return { available: false, reason: 'missing-both-pairs', missingIds, matches: [] };
  }

  const recordsA = new Map();
  const recordsB = new Map();

  for (const record of pairA.relatives) {
    const id = sharedIdOf(record);
    if (!id || id === owner || id === a || id === b) continue;
    recordsA.set(id, record);
  }

  for (const record of pairB.relatives) {
    const id = sharedIdOf(record);
    if (!id || id === owner || id === a || id === b) continue;
    recordsB.set(id, record);
  }

  const matches = [];

  for (const [id, recordA] of recordsA) {
    const recordB = recordsB.get(id);
    if (!recordB) continue;

    const ownerRecord = model.relativesById.get(id);
    const sidesA = recordSides(recordA, pairA.ownerIndex, ownerRecord);
    const sidesB = recordSides(recordB, pairB.ownerIndex, ownerRecord);
    if (!sidesA || !sidesB) continue;

    const otherA = sideValues(recordA, primaryOtherIndex(recordA, sidesA.otherIndexes));
    const otherB = sideValues(recordB, primaryOtherIndex(recordB, sidesB.otherIndexes));

    matches.push(matchResult(
      recordA,
      model.peopleById.get(id),
      otherA.relationship,
      otherA.proportion,
      otherA.segments,
      otherB.relationship,
      otherB.proportion,
      otherB.segments,
    ));
  }

  sortSharedMatches(matches);

  return { available: true, reason: '', missingIds: [], matches };
}
