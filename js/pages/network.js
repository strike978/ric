/*
 * Shared DNA network page
 *
 * Draws one profile's saved relatives as an interactive network:
 *   - the profile in the middle
 *   - one edge per relative for that relative's direct sharing with the profile
 *   - extra edges between relatives that appear in each other's
 *     relatives-in-common lists, using the non-profile side of each row and
 *     averaging both directions when they are available
 *
 * The graph is rendered on a canvas with a small custom force simulation, so
 * it stays usable with hundreds of nodes and does not need a charting library.
 */

import { networkState as state } from '../core/state.js';
import { getProfileRelativesInCommon, getSavedRelatives } from '../data/db.js';
import { initialsOf, nameMatchesSearch, ownProfileUrl, profileUrl } from '../core/person.js';
import {
  cmFromProportion,
  ibdIndices,
  numberValue,
  ownerIndexEvidence,
} from '../core/dna.js';
import { formatRelationship } from '../core/relationships.js';
import { initialsOfName, labelName, preferences } from '../core/preferences.js';
import { appHeader, pageUrl } from '../ui/header.js';

const OWNER_ID = '__owner__';
const TAU = Math.PI * 2;

const params = new URLSearchParams(location.search);
const profileId = params.get('profile') || '';
const profileName = params.get('profile_name') || profileId || '';
const initialRelativeId = params.get('relative') || '';

state.profileId = profileId;
state.profileName = profileName;

let nodeById = new Map();
let featuredEdges = new Set();
let rawData = { relatives: [], pairs: [] };

/* ---------- Canvas state (not part of the Mithril view) ---------- */

const view = {
  canvas: null,
  ctx: null,
  stage: null,
  tooltip: null,
  observer: null,
  width: 0,
  height: 0,
  dpr: 1,
  camera: { x: 0, y: 0, scale: 1, ready: false, touched: false },
  hoveredId: '',
  dragging: null,
  panning: null,
  running: false,
  alpha: 0,
  raf: 0,
  lastHideNames: preferences.hideNames,
};

/* ---------- Graph model ---------- */

function radiusFor(ibd) {
  const value = numberValue(ibd) ?? 0;
  const strength = Math.sqrt(Math.min(value / 0.5, 1));
  return 6.5 + strength * 9.5;
}

// Preferred distance from the profile, based on direct sharing. The scale is
// logarithmic because each relationship step roughly halves IBD, so doubles of
// sharing should move a node by a similar amount.
function targetRadius(ibd) {
  const value = Math.max(numberValue(ibd) ?? 0, 0);
  const strength = Math.log10(1 + value / 0.001) / Math.log10(1 + 0.5 / 0.001);
  return 150 + 250 * (1 - Math.min(strength, 1));
}

// Normalised 0..1 sharing strength. Peer links use a lower cap so that the
// small proportions usually seen between relatives-in-common still spread out.
function shareStrength(value, max) {
  const number = numberValue(value) ?? 0;
  return Math.sqrt(Math.min(number / max, 1));
}

// With the profile-side column known, return the other context.
function sharingFromRow(row, ownerIndex) {
  const indices = ibdIndices(row);
  let peerIndex = null;

  for (const index of indices) {
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
    weight: numberValue(row['ibd_proportion_' + peerIndex]),
    relationship: row['predicted_relationship_id_' + peerIndex] || '',
    segments: numberValue(row['num_segments_' + peerIndex]),
    ownerIndex,
    peerIndex,
  };
}

function radiusForMatch(ibd) {
  const value = numberValue(ibd) ?? 0;
  const strength = Math.sqrt(Math.min(value / 0.5, 1));
  return 4.5 + strength * 5.5;
}

function average(values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (!numbers.length) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

// A common match that is not a saved relative has no direct record to compare
// against. If it appears in several lists, the profile-side proportion should
// be the same in all of them, while the relative-side proportion varies.
function ownerIndexForMatch(rows, fallback) {
  if (rows.length < 2) return fallback;

  const spread = (index) => {
    const values = [];
    for (const { row } of rows) {
      const value = numberValue(row['ibd_proportion_' + index]);
      if (value !== null) values.push(value);
    }
    if (values.length < 2) return Infinity;
    return Math.max(...values) - Math.min(...values);
  };

  const one = spread(1);
  const two = spread(2);
  if (one < two) return 1;
  if (two < one) return 2;
  return fallback;
}

function filtersActive(filters = state.filters) {
  return Boolean(
    String(filters.name || '').trim()
    || numberValue(filters.minCM) !== null
    || numberValue(filters.maxCM) !== null
    || String(filters.maternal || '').trim()
    || String(filters.paternal || '').trim(),
  );
}

// Filters that change the graph itself. The last-name search is only a list
// filter, so it is not included.
function graphFiltersActive(filters = state.filters) {
  return Boolean(
    numberValue(filters.minCM) !== null
    || numberValue(filters.maxCM) !== null
    || String(filters.maternal || '').trim()
    || String(filters.paternal || '').trim(),
  );
}

function haplogroupMatches(value, filter) {
  const needle = String(filter || '').trim().toLowerCase();
  if (!needle) return true;

  return String(value || '').trim().toLowerCase().startsWith(needle);
}

// A node passes when its sharing with the profile falls inside the cM bounds
// and its haplogroups begin with the typed text. The name search is only a list
// filter, so it is skipped here unless includeName is set. Empty fields impose
// no constraint.
function passesFilters(person, ibd, filters, includeName = true) {
  if (!filters) return true;

  if (includeName && !nameMatchesSearch(person, filters.name)) return false;

  const min = numberValue(filters.minCM);
  const max = numberValue(filters.maxCM);
  if (min !== null || max !== null) {
    const cM = cmFromProportion(ibd);
    if (cM === null) return false;
    if (min !== null && cM < min) return false;
    if (max !== null && cM > max) return false;
  }

  const maternal = String(filters.maternal || '').trim();
  const paternal = String(filters.paternal || '').trim();
  if (maternal || paternal) {
    // Females have no Y chromosome, so a Y-DNA filter never matches them.
    if (paternal && isFemale(person)) return false;

    const groups = person && person.haplogroups;
    if (!groups) return false;
    if (!haplogroupMatches(groups.maternal, maternal)) return false;
    if (!haplogroupMatches(groups.paternal, paternal)) return false;
  }

  return true;
}

function buildGraph(relatives, pairs, includeSharedMatches = true, filters = state.filters) {
  const nodes = [];
  const byId = new Map();
  // Keep the current layout for nodes that survive a filter change so the
  // graph does not jump around while the user types.
  const previous = new Map((state.nodes || []).map((node) => [node.id, node]));
  const preserved = new Set();

  const owner = {
    id: OWNER_ID,
    kind: 'owner',
    person: { initials: initialsOfName(profileName || 'Profile'), first_name: profileName || 'Profile' },
    ibd: null,
    radius: 22,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    pinned: true,
    degree: 0,
  };
  nodes.push(owner);
  byId.set(owner.id, owner);

  const savedRelativeNodes = [];
  const seen = new Set([OWNER_ID]);
  for (const relative of relatives) {
    const id = String((relative && relative.relative_profile_id) || '').trim();
    if (!id || seen.has(id)) continue;

    const ibd = numberValue(relative.ibd_proportion);
    if (!passesFilters(relative, ibd, filters, false)) continue;

    seen.add(id);
    const old = previous.get(id);
    if (old) preserved.add(id);

    const node = {
      id,
      kind: 'relative',
      person: relative,
      ibd,
      radius: radiusFor(ibd),
      x: old ? old.x : 0,
      y: old ? old.y : 0,
      vx: old ? old.vx : 0,
      vy: old ? old.vy : 0,
      pinned: old ? old.pinned : false,
      degree: 0,
    };
    nodes.push(node);
    byId.set(id, node);
    savedRelativeNodes.push(node);
  }

  const edges = [];
  const edgeByKey = new Map();

  function addEdge(source, target, weightValue, kind, relationship, segments, meta = {}) {
    if (!source || !target || source === target) return;

    const weight = numberValue(weightValue);
    if (weight === null || weight <= 0) return;

    const key = source.id < target.id
      ? source.id + '\u0000' + target.id
      : target.id + '\u0000' + source.id;
    const existing = edgeByKey.get(key);

    if (existing) {
      if (weight > existing.weight) {
        existing.weight = weight;
        if (relationship) existing.relationship = relationship;
        if (segments !== null) existing.segments = segments;
      }
      return;
    }

    const edge = {
      id: key,
      source,
      target,
      weight,
      kind,
      relationship: relationship || '',
      segments: segments === undefined ? null : segments,
      confirmed: kind === 'owner' ? true : Boolean(meta.confirmed),
      samples: meta.samples || 1,
    };
    edgeByKey.set(key, edge);
    edges.push(edge);
  }

  const sharedPairs = new Map();
  const matchStats = new Map();
  const ownerVotes = { 1: 0, 2: 0 };

  function addSharedSample(a, b, sharing) {
    const key = a.id < b.id
      ? a.id + '\u0000' + b.id
      : b.id + '\u0000' + a.id;
    let entry = sharedPairs.get(key);
    if (!entry) {
      entry = { a, b, samples: new Map() };
      sharedPairs.set(key, entry);
    }
    entry.samples.set(a.id + '\u0000' + b.id, sharing);
  }

  // First pass: saved-relative edges, orientation votes, and every common match
  // that is not itself one of the saved relatives.
  for (const pair of pairs) {
    const a = byId.get(String((pair && pair.relative_profile_id) || '').trim());
    if (!a || a.kind !== 'relative') continue;

    const common = Array.isArray(pair.relatives) ? pair.relatives : [];
    for (const row of common) {
      // Copied rows only fill in another pair's table. The fetched relative's
      // own pair already supplies this connection, so counting the copy would
      // pretend it was seen from both directions.
      if (row && row.derived) continue;

      const commonId = String((row && row.profile_id) || '').trim();
      if (!commonId || commonId === a.id) continue;

      const b = byId.get(commonId);

      if (b && b.kind === 'relative') {
        const ownerIndex = ownerIndexEvidence(row, b.person);
        if (ownerIndex === null) continue;

        ownerVotes[ownerIndex] += 1;
        const sharing = sharingFromRow(row, ownerIndex);
        if (!sharing) continue;
        addSharedSample(a, b, sharing);
        continue;
      }

      let stat = matchStats.get(commonId);
      if (!stat) {
        stat = { id: commonId, pairIds: new Set(), rows: [] };
        matchStats.set(commonId, stat);
      }
      stat.pairIds.add(a.id);
      stat.rows.push({ a, row });
    }
  }

  // Edges between saved relatives.
  for (const entry of sharedPairs.values()) {
    const samples = [...entry.samples.values()];
    const weight = samples.reduce((sum, sample) => sum + sample.weight, 0) / samples.length;
    const best = samples.reduce(
      (chosen, sample) => (sample.weight > chosen.weight ? sample : chosen),
      samples[0],
    );

    addEdge(entry.a, entry.b, weight, 'shared', best.relationship, best.segments, {
      confirmed: samples.length > 1,
      samples: samples.length,
    });
  }

  // Most rows agree on which column is the profile side; use that as the
  // fallback for matches that do not have their own saved record.
  const globalOwnerIndex = ownerVotes[1] >= ownerVotes[2] ? 1 : 2;

  const includedMatches = [];

  if (includeSharedMatches) {
    for (const stat of matchStats.values()) {
      if (stat.pairIds.size < 2) continue;

      const matchOwnerIndex = ownerIndexForMatch(stat.rows, globalOwnerIndex);
      const entries = [];
      const ownerWeights = [];
      const ownerSegments = [];
      let ownerRelationship = '';

      for (const { a, row } of stat.rows) {
        const sharing = sharingFromRow(row, matchOwnerIndex);
        if (sharing) entries.push({ a, sharing });

        const ownerWeight = numberValue(row['ibd_proportion_' + matchOwnerIndex]);
        if (ownerWeight !== null) ownerWeights.push(ownerWeight);

        const segmentValue = numberValue(row['num_segments_' + matchOwnerIndex]);
        if (segmentValue !== null) ownerSegments.push(segmentValue);

        if (!ownerRelationship) {
          ownerRelationship = row['predicted_relationship_id_' + matchOwnerIndex] || '';
        }
      }

      if (!entries.length) continue;

      const firstRow = stat.rows[0].row;
      const person = {
        relative_profile_id: stat.id,
        first_name: firstRow.first_name,
        last_name: firstRow.last_name,
        first_initial: firstRow.first_initial,
        last_initial: firstRow.last_initial,
        initials: firstRow.initials,
        sex: firstRow.sex,
        profile_image_url: firstRow.profile_image_url,
        predicted_relationship_id: ownerRelationship,
        ibd_proportion: average(ownerWeights),
        num_segments: average(ownerSegments),
      };
      const ibd = numberValue(person.ibd_proportion);
      if (!passesFilters(person, ibd, filters, false)) continue;

      const old = previous.get(stat.id);
      if (old) preserved.add(stat.id);

      const node = {
        id: stat.id,
        kind: 'match',
        person,
        ibd,
        radius: radiusForMatch(ibd),
        pairCount: stat.pairIds.size,
        x: old ? old.x : 0,
        y: old ? old.y : 0,
        vx: old ? old.vx : 0,
        vy: old ? old.vy : 0,
        pinned: old ? old.pinned : false,
        degree: 0,
      };
      nodes.push(node);
      byId.set(node.id, node);
      includedMatches.push({ node, entries });
    }
  }

  // Seed every node on a phyllotaxis spiral, strongest sharing first, at a
  // radius that reflects how closely they share with the profile.
  const positioned = nodes
    .filter((node) => node.kind !== 'owner')
    .sort((a, b) => (b.ibd ?? 0) - (a.ibd ?? 0));
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  positioned.forEach((node, index) => {
    if (preserved.has(node.id)) return;

    const angle = index * goldenAngle;
    const radius = targetRadius(node.ibd);
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * radius;
  });

  // The profile's own sharing with each relative.
  for (const node of savedRelativeNodes) {
    addEdge(
      owner,
      node,
      node.ibd,
      'owner',
      node.person.predicted_relationship_id,
      numberValue(node.person.num_segments),
    );
  }

  // Edges from saved relatives to common matches that are not saved relatives.
  for (const { node, entries } of includedMatches) {
    for (const { a, sharing } of entries) {
      addEdge(
        a,
        node,
        sharing.weight,
        'shared',
        sharing.relationship,
        sharing.segments,
        { confirmed: false, samples: 1 },
      );
    }
  }

  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    edge.source.degree += 1;
    edge.target.degree += 1;
    adjacency.get(edge.source.id).push({ node: edge.target, edge });
    adjacency.get(edge.target.id).push({ node: edge.source, edge });
  }
  for (const list of adjacency.values()) {
    list.sort((a, b) => b.edge.weight - a.edge.weight);
  }

  // The overview stays readable by drawing only a handful of shared links,
  // preferring links confirmed from both directions.
  featuredEdges = new Set(
    edges
      .filter((edge) => edge.kind === 'shared')
      .sort((a, b) => (Number(b.confirmed) - Number(a.confirmed)) || (b.weight - a.weight))
      .slice(0, 16)
      .map((edge) => edge.id),
  );

  const sharedEdges = edges.filter((edge) => edge.kind === 'shared');

  nodeById = byId;
  state.owner = owner;
  state.nodes = nodes;
  state.edges = edges;
  state.adjacency = adjacency;
  state.selectedId = '';
  state.stats = {
    relatives: savedRelativeNodes.length,
    totalRelatives: relatives.length,
    matches: includedMatches.length,
    connections: edges.length,
    shared: sharedEdges.length,
    confirmed: sharedEdges.filter((edge) => edge.confirmed).length,
    oneSided: sharedEdges.filter((edge) => !edge.confirmed).length,
  };
}

/* ---------- Presentation helpers ---------- */

function nodeColor(node) {
  if (node.kind === 'owner') return '#8ab4f8';
  if (node.kind === 'match') return '#6f7f95';

  const sex = String(node.person && node.person.sex || '').trim().toLowerCase();
  if (sex === 'female' || sex === 'f') return '#b35482';
  if (sex === 'male' || sex === 'm') return '#3d74b8';
  return '#4a5568';
}

function nodeName(node) {
  if (!node) return '';
  if (node.kind === 'owner') return profileName || 'Profile';
  return labelName(node.person);
}

function nodeInitials(node) {
  if (node.kind === 'owner') return initialsOfName(profileName || 'Profile').slice(0, 2);
  return initialsOf(node.person).slice(0, 2);
}

function relationshipOf(value) {
  const label = formatRelationship(value);
  return label === '—' ? '' : label;
}

// Name and relationship only; shared cM, segments, and link count sit in the
// stat strip below so the header stays short.
function nodeSubtitle(node) {
  if (!node || node.kind === 'owner') return 'Profile';

  if (node.kind === 'match') {
    return [
      'Common match',
      relationshipOf(node.person.predicted_relationship_id),
    ].filter(Boolean).join(' · ');
  }

  return relationshipOf(node.person.predicted_relationship_id) || 'Relative';
}

// Shared cM for an edge, ready for display.
function edgeCM(edge) {
  const cM = cmFromProportion(edge.weight);
  return cM === null ? '—' : cM + ' cM';
}

function edgeRelationship(edge, fallbackNode) {
  return relationshipOf(edge.relationship)
    || relationshipOf(fallbackNode && fallbackNode.person && fallbackNode.person.predicted_relationship_id)
    || 'Shared match';
}

function selectedNode() {
  return state.selectedId ? nodeById.get(state.selectedId) || null : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function localPoint(event) {
  const rect = view.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function project(node) {
  return {
    x: view.width / 2 + (node.x - view.camera.x) * view.camera.scale,
    y: view.height / 2 + (node.y - view.camera.y) * view.camera.scale,
  };
}

function unproject(x, y) {
  return {
    x: view.camera.x + (x - view.width / 2) / view.camera.scale,
    y: view.camera.y + (y - view.height / 2) / view.camera.scale,
  };
}

/* ---------- Simulation ---------- */

function startSimulation(fresh = true) {
  if (!view.ctx) return;

  if (state.nodes.length <= 1) {
    fitView();
    return;
  }

  view.alpha = fresh ? 1 : Math.max(view.alpha, 0.75);
  if (fresh) fitView();

  view.running = true;
  cancelAnimationFrame(view.raf);
  view.raf = requestAnimationFrame(simulationFrame);
}

function edgeIdealLength(edge) {
  return 90 + 210 * (1 - shareStrength(edge.weight, 0.15));
}

function applySprings() {
  const alpha = view.alpha;

  for (const edge of state.edges) {
    // Direct sharing with the profile is handled by the radial force, so every
    // node type is positioned by the same rule.
    if (edge.kind === 'owner') continue;

    const a = edge.source;
    const b = edge.target;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 0.01) {
      dx = (Math.random() - 0.5) * 2;
      dy = (Math.random() - 0.5) * 2;
      distance = Math.sqrt(dx * dx + dy * dy) || 1;
    }

    const ideal = edgeIdealLength(edge);
    const spring = 0.03
      * (0.45 + shareStrength(edge.weight, 0.15))
      * alpha;
    const force = (distance - ideal) * spring;
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;

    if (!a.pinned) { a.vx += fx; a.vy += fy; }
    if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
  }
}

function applyRepulsion() {
  const cellSize = 86;
  const cutoffSq = (cellSize * 1.7) ** 2;
  const alpha = view.alpha;
  const grid = new Map();

  for (const node of state.nodes) {
    const cx = Math.floor(node.x / cellSize);
    const cy = Math.floor(node.y / cellSize);
    const key = cx + ',' + cy;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(node);
  }

  for (const node of state.nodes) {
    const cx = Math.floor(node.x / cellSize);
    const cy = Math.floor(node.y / cellSize);

    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = grid.get((cx + ox) + ',' + (cy + oy));
        if (!bucket) continue;

        for (const other of bucket) {
          if (other === node || other.id < node.id) continue;

          const dx = other.x - node.x;
          const dy = other.y - node.y;
          const distanceSq = Math.max(dx * dx + dy * dy, 1);
          if (distanceSq > cutoffSq) continue;

          const distance = Math.sqrt(distanceSq);
          const force = Math.min(3200 / distanceSq, 55) * alpha;
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;

          if (!node.pinned) { node.vx -= fx; node.vy -= fy; }
          if (!other.pinned) { other.vx += fx; other.vy += fy; }
        }
      }
    }
  }
}

function applyRadial() {
  for (const node of state.nodes) {
    if (node.kind === 'owner' || node.pinned) continue;

    const distance = Math.sqrt(node.x * node.x + node.y * node.y) || 1;
    const target = targetRadius(node.ibd);
    const pull = (target - distance) * 0.008 * view.alpha;
    node.vx += (node.x / distance) * pull;
    node.vy += (node.y / distance) * pull;
  }
}

function integrate() {
  const alpha = view.alpha;

  for (const node of state.nodes) {
    if (node.pinned) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }

    node.vx += -node.x * 0.0005 * alpha;
    node.vy += -node.y * 0.0005 * alpha;

    node.vx = clamp(node.vx * 0.86, -28, 28);
    node.vy = clamp(node.vy * 0.86, -28, 28);

    node.x += node.vx;
    node.y += node.vy;
  }
}

function simulationFrame() {
  view.alpha *= 0.975;

  const steps = view.alpha > 0.5 ? 2 : 1;
  for (let step = 0; step < steps; step++) {
    applySprings();
    applyRadial();
    applyRepulsion();
    integrate();
  }

  draw();

  if (view.alpha < 0.012 && !view.dragging) {
    view.running = false;
    if (!view.camera.touched) fitView();
    else draw();
    return;
  }

  view.raf = requestAnimationFrame(simulationFrame);
}

/* ---------- Camera and drawing ---------- */

function fitView() {
  if (!state.nodes.length || !view.width || !view.height) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of state.nodes) {
    minX = Math.min(minX, node.x - node.radius);
    minY = Math.min(minY, node.y - node.radius);
    maxX = Math.max(maxX, node.x + node.radius);
    maxY = Math.max(maxY, node.y + node.radius);
  }

  const padding = 68;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.min(
    (view.width - padding * 2) / spanX,
    (view.height - padding * 2) / spanY,
  );

  view.camera.scale = clamp(scale, 0.12, 3);
  view.camera.x = (minX + maxX) / 2;
  view.camera.y = (minY + maxY) / 2;
  view.camera.ready = true;
  view.camera.touched = false;
  draw();
}

function zoomBy(factor) {
  view.camera.scale = clamp(view.camera.scale * factor, 0.08, 4);
  view.camera.touched = true;
  draw();
}

// Overview shows the strongest shared links; hovering or selecting a node adds
// all of that node's links.
function edgeIsVisible(edge, focus) {
  if (edge.kind === 'owner') return true;
  if (focus && (edge.source === focus || edge.target === focus)) return true;
  return featuredEdges.has(edge.id);
}

function drawGrid() {
  const ctx = view.ctx;
  let step = 80;

  while (step * view.camera.scale < 46) step *= 2;
  while (step * view.camera.scale > 160) step /= 2;

  const topLeft = unproject(0, 0);
  const bottomRight = unproject(view.width, view.height);
  const startX = Math.floor(topLeft.x / step) * step;
  const startY = Math.floor(topLeft.y / step) * step;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
  for (let x = startX; x <= bottomRight.x; x += step) {
    for (let y = startY; y <= bottomRight.y; y += step) {
      const point = project({ x, y });
      ctx.beginPath();
      ctx.arc(point.x, point.y, 1, 0, TAU);
      ctx.fill();
    }
  }
}

function draw() {
  const ctx = view.ctx;
  if (!ctx || !view.width || !view.height) return;

  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);

  drawGrid();

  const focus = (view.hoveredId ? nodeById.get(view.hoveredId) : null)
    || selectedNode()
    || null;
  const nearby = focus
    ? new Set((state.adjacency.get(focus.id) || []).map((item) => item.node.id))
    : null;

  // Edges first so nodes sit on top.
  for (const edge of state.edges) {
    if (!edgeIsVisible(edge, focus)) continue;

    const a = project(edge.source);
    const b = project(edge.target);
    if ((a.x < -80 && b.x < -80)
      || (a.x > view.width + 80 && b.x > view.width + 80)
      || (a.y < -80 && b.y < -80)
      || (a.y > view.height + 80 && b.y > view.height + 80)) continue;

    const active = focus && (edge.source === focus || edge.target === focus);
    const dimmed = focus && !active;
    if (dimmed && edge.kind === 'shared') continue;

    const rgb = edge.kind === 'owner' ? '138, 180, 248' : '197, 138, 249';
    const base = edge.kind === 'owner'
      ? 0.1 + Math.min(edge.weight * 1.6, 0.6)
      : edge.confirmed
        ? 0.19 + Math.min(edge.weight * 1.4, 0.48)
        : 0.12 + Math.min(edge.weight * 1.2, 0.35);
    const alphaValue = dimmed ? 0.05 : active ? Math.min(base + 0.25, 0.95) : base;

    ctx.strokeStyle = 'rgba(' + rgb + ',' + alphaValue + ')';
    ctx.lineWidth = Math.max(0.7, Math.min(4.5, 0.7 + edge.weight * 7))
      + (active ? 0.6 : 0);
    ctx.setLineDash(edge.kind === 'shared'
      ? (edge.confirmed ? [5, 5] : [2, 4])
      : []);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Nodes.
  for (const node of state.nodes) {
    const point = project(node);
    if (point.x < -70 || point.x > view.width + 70
      || point.y < -70 || point.y > view.height + 70) continue;

    const radius = Math.max(3, node.radius * view.camera.scale);
    const dimmed = nearby && !nearby.has(node.id) && node !== focus;
    const isSelected = state.selectedId === node.id;
    const isHovered = view.hoveredId === node.id;

    ctx.globalAlpha = dimmed ? 0.22 : 1;

    if (node.kind === 'owner') {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius + 9, 0, TAU);
      ctx.fillStyle = 'rgba(138, 180, 248, 0.1)';
      ctx.fill();
    }

    if (isSelected || isHovered) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius + 5, 0, TAU);
      ctx.fillStyle = 'rgba(232, 234, 237, 0.14)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(point.x, point.y, radius + 2, 0, TAU);
      ctx.strokeStyle = '#e8eaed';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, TAU);
    ctx.fillStyle = nodeColor(node);
    ctx.fill();
    ctx.strokeStyle = 'rgba(9, 12, 17, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (node.kind === 'owner') {
      ctx.strokeStyle = 'rgba(232, 234, 237, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (node.kind === 'match') {
      ctx.strokeStyle = 'rgba(197, 138, 249, 0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (radius >= 7) {
      ctx.fillStyle = node.kind === 'owner' ? '#11151c' : '#f4f7ff';
      ctx.font = '600 ' + Math.max(8, Math.min(radius * 0.95, 13))
        + 'px "Atkinson Hyperlegible", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(nodeInitials(node), point.x, point.y + 0.5);
    }

    ctx.globalAlpha = 1;
  }

  // Names on top. Draw the most important labels first and skip any label that
  // would overlap one already placed.
  if (state.labels) {
    drawLabels(focus, nearby);
  }
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawLabels(focus, nearby) {
  const ctx = view.ctx;
  const candidates = [];

  for (const node of state.nodes) {
    if (nearby && !nearby.has(node.id) && node !== focus) continue;

    const isFocus = node === focus;
    const radius = Math.max(3, node.radius * view.camera.scale);

    // When names are hidden, put the initials on small nodes instead of
    // leaving them unlabelled. Larger nodes already show initials inside.
    if (preferences.hideNames && node.kind !== 'owner' && !isFocus && radius >= 7) continue;

    const point = project(node);
    if (point.x < -90 || point.x > view.width + 90
      || point.y < -40 || point.y > view.height + 40) continue;

    const priority = isFocus
      ? 0
      : node.kind === 'owner'
        ? 1
        : 2 + (1 - Math.min((node.ibd ?? 0) / 0.5, 1));

    const label = nodeName(node);
    if (!label) continue;

    candidates.push({ node, label, point, radius, isFocus, priority });
  }

  candidates.sort((a, b) => a.priority - b.priority);

  const placed = [];
  // Labels never overlap, so the cap only needs to scale gently with zoom.
  // A floor keeps the closest relatives named even when the whole graph fits.
  const maxLabels = Math.min(140, Math.max(18, Math.round(14 + view.camera.scale * 50))
    + (preferences.hideNames ? 30 : 0));
  let drawn = 0;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const candidate of candidates) {
    if (drawn >= maxLabels) break;

    const { label, point, radius, isFocus, node } = candidate;
    ctx.font = (isFocus || node.kind === 'owner' ? '600 ' : '500 ')
      + '11px "Atkinson Hyperlegible", system-ui, sans-serif';

    const width = Math.ceil(ctx.measureText(label).width) + 12;
    const height = 18;
    const left = point.x - width / 2;
    const top = point.y + radius + 7;
    const right = left + width;
    const bottom = top + height;

    if (right < 0 || left > view.width || bottom < 0 || top > view.height) continue;

    const collision = placed.some((rect) => !(
      right < rect.left || left > rect.right || bottom < rect.top || top > rect.bottom
    ));
    if (collision) continue;

    placed.push({ left, right, top, bottom });
    drawn += 1;

    ctx.globalAlpha = 1;
    roundRect(ctx, left, top, width, height, 6);
    ctx.fillStyle = isFocus ? 'rgba(25, 31, 42, 0.97)' : 'rgba(15, 19, 26, 0.84)';
    ctx.fill();

    if (isFocus) {
      ctx.strokeStyle = 'rgba(138, 180, 248, 0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.fillStyle = isFocus ? '#ffffff' : 'rgba(232, 234, 237, 0.92)';
    ctx.fillText(label, point.x, top + height / 2 + 0.5);
  }
}

/* ---------- Pointer interaction ---------- */

function hitTest(point) {
  for (let index = state.nodes.length - 1; index >= 0; index--) {
    const node = state.nodes[index];
    const projected = project(node);
    const radius = Math.max(7, node.radius * view.camera.scale + 4);
    const dx = projected.x - point.x;
    const dy = projected.y - point.y;
    if (dx * dx + dy * dy <= radius * radius) return node;
  }
  return null;
}

function updateTooltip(node, point) {
  const tooltip = view.tooltip;
  if (!tooltip) return;

  if (!node) {
    tooltip.classList.add('hidden');
    return;
  }

  const connections = (state.adjacency.get(node.id) || []).length;
  const parts = [nodeSubtitle(node)];
  if (node.kind !== 'owner') {
    const cM = cmFromProportion(node.person.ibd_proportion);
    if (cM !== null) parts.push(cM + ' cM with profile');
  }
  if (node.kind === 'relative') parts.push(connections + (connections === 1 ? ' link' : ' links'));

  tooltip.replaceChildren(
    Object.assign(document.createElement('strong'), { textContent: nodeName(node) }),
    Object.assign(document.createElement('span'), { textContent: parts.filter(Boolean).join(' · ') }),
  );
  tooltip.classList.remove('hidden');

  const maxX = view.width - tooltip.offsetWidth - 10;
  const maxY = view.height - tooltip.offsetHeight - 10;
  tooltip.style.transform = 'translate('
    + Math.max(8, Math.min(point.x + 14, maxX)) + 'px, '
    + Math.max(8, Math.min(point.y + 14, maxY)) + 'px)';
}

function hideTooltip() {
  if (view.tooltip) view.tooltip.classList.add('hidden');
}

function selectNode(node, center = false) {
  state.selectedId = node ? node.id : '';
  if (node && center) {
    view.camera.x = node.x;
    view.camera.y = node.y;
    view.camera.touched = true;
  }
  m.redraw.sync();
  draw();
}

function toggleSharedMatches() {
  state.includeSharedMatches = !state.includeSharedMatches;
  state.selectedId = '';
  buildGraph(rawData.relatives, rawData.pairs, state.includeSharedMatches, state.filters);
  hideTooltip();
  m.redraw.sync();
  startSimulation();
}

/* ---------- Filtering ---------- */

let filterTimer = 0;

function applyFilters(fresh = false) {
  clearTimeout(filterTimer);
  filterTimer = 0;

  buildGraph(rawData.relatives, rawData.pairs, state.includeSharedMatches, state.filters);
  hideTooltip();
  m.redraw.sync();
  startSimulation(fresh);
}

// Wait for a pause in typing before rebuilding the graph.
function scheduleFilterApply() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    filterTimer = 0;
    applyFilters();
  }, 180);
}

function clearFilters() {
  state.filters.name = '';
  state.filters.minCM = '';
  state.filters.maxCM = '';
  state.filters.maternal = '';
  state.filters.paternal = '';
  applyFilters();
}

function onPointerDown(event) {
  if (event.button !== 0 || !view.canvas) return;

  const point = localPoint(event);
  const node = hitTest(point);
  view.canvas.setPointerCapture(event.pointerId);

  if (node) {
    view.dragging = {
      node,
      start: point,
      moved: 0,
      pinning: false,
      wasPinned: node.pinned,
    };
    view.hoveredId = node.id;
    updateTooltip(node, point);
    draw();
  } else {
    view.panning = {
      start: point,
      cameraX: view.camera.x,
      cameraY: view.camera.y,
      moved: 0,
    };
    view.canvas.classList.add('is-panning');
    hideTooltip();
  }
}

function onPointerMove(event) {
  if (!view.canvas) return;

  const point = localPoint(event);

  if (view.dragging) {
    const drag = view.dragging;
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    drag.moved = Math.max(drag.moved, Math.sqrt(dx * dx + dy * dy));

    if (drag.moved > 3) {
      if (!drag.pinning) {
        drag.pinning = true;
        drag.node.pinned = true;
      }

      const world = unproject(point.x, point.y);
      drag.node.x = world.x;
      drag.node.y = world.y;
      drag.node.vx = 0;
      drag.node.vy = 0;

      view.alpha = Math.max(view.alpha, 0.35);
      if (!view.running) {
        view.running = true;
        view.raf = requestAnimationFrame(simulationFrame);
      }

      draw();
      updateTooltip(drag.node, point);
    }
    return;
  }

  if (view.panning) {
    const pan = view.panning;
    const dx = point.x - pan.start.x;
    const dy = point.y - pan.start.y;
    pan.moved = Math.max(pan.moved, Math.sqrt(dx * dx + dy * dy));

    view.camera.x = pan.cameraX - dx / view.camera.scale;
    view.camera.y = pan.cameraY - dy / view.camera.scale;
    view.camera.touched = true;
    draw();
    return;
  }

  const node = hitTest(point);
  if ((node ? node.id : '') !== view.hoveredId) {
    view.hoveredId = node ? node.id : '';
    draw();
  }
  updateTooltip(node, point);
  view.canvas.style.cursor = node ? 'pointer' : 'grab';
}

function onPointerUp(event) {
  if (!view.canvas) return;

  if (view.dragging) {
    const drag = view.dragging;
    view.dragging = null;

    if (drag.moved <= 4) {
      // A click, not a drag.
      if (drag.pinning) drag.node.pinned = drag.wasPinned;
      selectNode(drag.node);
    }
  } else if (view.panning) {
    const pan = view.panning;
    view.panning = null;
    view.canvas.classList.remove('is-panning');
    if (pan.moved <= 4) selectNode(null);
  }

  if (view.canvas.hasPointerCapture(event.pointerId)) {
    view.canvas.releasePointerCapture(event.pointerId);
  }
}

function onPointerLeave() {
  if (view.dragging || view.panning) return;
  if (view.hoveredId) {
    view.hoveredId = '';
    draw();
  }
  hideTooltip();
}

function onWheel(event) {
  event.preventDefault();

  const point = localPoint(event);
  const before = unproject(point.x, point.y);
  const factor = Math.exp(-event.deltaY * 0.0015);
  view.camera.scale = clamp(view.camera.scale * factor, 0.08, 4);

  const after = unproject(point.x, point.y);
  view.camera.x += before.x - after.x;
  view.camera.y += before.y - after.y;
  view.camera.touched = true;
  draw();
}

/* ---------- Canvas lifecycle ---------- */

function resizeCanvas() {
  if (!view.canvas || !view.stage) return;

  const rect = view.stage.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));

  view.width = width;
  view.height = height;
  view.dpr = Math.max(1, window.devicePixelRatio || 1);

  view.canvas.width = Math.round(width * view.dpr);
  view.canvas.height = Math.round(height * view.dpr);
  view.canvas.style.width = width + 'px';
  view.canvas.style.height = height + 'px';

  if (!view.camera.ready) {
    view.camera.ready = true;
    fitView();
  } else if (!view.camera.touched) {
    fitView();
  } else {
    draw();
  }
}

function setupCanvas(vnode) {
  view.canvas = vnode.dom;
  view.stage = vnode.dom.parentElement;
  view.ctx = vnode.dom.getContext('2d');

  view.canvas.addEventListener('wheel', onWheel, { passive: false });
  view.canvas.addEventListener('pointerdown', onPointerDown);
  view.canvas.addEventListener('pointermove', onPointerMove);
  view.canvas.addEventListener('pointerup', onPointerUp);
  view.canvas.addEventListener('pointercancel', onPointerUp);
  view.canvas.addEventListener('pointerleave', onPointerLeave);

  view.observer = new ResizeObserver(resizeCanvas);
  view.observer.observe(view.stage);

  resizeCanvas();

  if (state.nodes.length > 1) startSimulation();
  else draw();

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => draw());
  }
}

function teardownCanvas() {
  if (view.observer) {
    view.observer.disconnect();
    view.observer = null;
  }
  cancelAnimationFrame(view.raf);
  view.running = false;

  if (view.canvas) {
    view.canvas.removeEventListener('wheel', onWheel);
    view.canvas.removeEventListener('pointerdown', onPointerDown);
    view.canvas.removeEventListener('pointermove', onPointerMove);
    view.canvas.removeEventListener('pointerup', onPointerUp);
    view.canvas.removeEventListener('pointercancel', onPointerUp);
    view.canvas.removeEventListener('pointerleave', onPointerLeave);
  }

  view.canvas = null;
  view.ctx = null;
  view.stage = null;
  view.tooltip = null;
}

/* ---------- Data ---------- */

async function loadNetwork() {
  if (!profileId) {
    state.loading = false;
    state.notice = 'No profile selected. Choose a profile on the relatives page, then open the network from there.';
    m.redraw.sync();
    return;
  }

  try {
    const [relatives, pairs] = await Promise.all([
      getSavedRelatives(profileId),
      getProfileRelativesInCommon(profileId),
    ]);

    const savedIds = new Set(relatives
      .map((relative) => String((relative && relative.relative_profile_id) || '').trim())
      .filter(Boolean));

    // A relative belongs in the graph only when its relatives-in-common list
    // was fetched and actually contains matches.
    const comparedIds = new Set();
    for (const pair of pairs) {
      if (!pair || !Array.isArray(pair.relatives) || pair.relatives.length === 0) continue;

      const id = String(pair.relative_profile_id || '').trim();
      if (id) comparedIds.add(id);
    }

    const visibleRelatives = relatives.filter((relative) => {
      const id = String((relative && relative.relative_profile_id) || '').trim();
      return id && comparedIds.has(id);
    });

    // Saved relatives without data must not reappear as common-match nodes.
    const hiddenIds = new Set([...savedIds].filter((id) => !comparedIds.has(id)));
    const visiblePairs = pairs.map((pair) => {
      if (!pair || !Array.isArray(pair.relatives)) return pair;

      return {
        ...pair,
        relatives: pair.relatives.filter((row) => {
          const id = String((row && row.profile_id) || '').trim();
          return !hiddenIds.has(id);
        }),
      };
    });

    rawData = { relatives: visibleRelatives, pairs: visiblePairs };
    buildGraph(visibleRelatives, visiblePairs, state.includeSharedMatches, state.filters);
    if (initialRelativeId && nodeById.has(initialRelativeId)) {
      state.selectedId = initialRelativeId;
    }
    state.loading = false;

    if (relatives.length === 0) {
      state.notice = 'No saved relatives for this profile yet. Load relatives on the relatives page first.';
    } else if (visibleRelatives.length === 0) {
      state.notice = 'No relatives with saved relatives-in-common matches yet. Use Start on the relatives page first.';
    } else {
      state.notice = '';
    }
  } catch {
    state.loading = false;
    state.notice = 'Could not read the local database.';
  } finally {
    m.redraw.sync();
    if (view.ctx && state.nodes.length > 1) startSimulation();
    else draw();
  }
}

/* ---------- View ---------- */

function externalIcon() {
  return m('svg.network-row-link-icon', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }, [
    m('path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }),
    m('path', { d: 'M15 3h6v6' }),
    m('path', { d: 'M10 14 21 3' }),
  ]);
}

// A list row selects the person in the graph, with a separate link to their
// 23andMe profile. The link sits outside the button because an anchor cannot
// be nested inside one.
function rowShell(node, button) {
  const url = node.kind === 'owner' ? null : profileUrl(profileId, node.id);
  if (!url) return button;

  const label = 'Open ' + nodeName(node) + ' on 23andMe';
  return m('div.network-row-wrap', [
    button,
    m('a.network-row-link', {
      href: url,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: label,
      'aria-label': label,
    }, externalIcon()),
  ]);
}

function haplogroupLine(person) {
  const groups = person && person.haplogroups;
  if (!groups) return null;

  const sex = String((person && person.sex) || '').trim().toLowerCase();
  const female = sex === 'female' || sex === 'f';

  const parts = [];
  if (groups.maternal) parts.push('mtDNA ' + groups.maternal);
  if (!female && groups.paternal) parts.push('Y-DNA ' + groups.paternal);
  if (parts.length === 0) return null;

  return m('span.network-row-haplogroups', parts.join(' · '));
}

function personRow(node, edge) {
  const cM = cmFromProportion(edge.weight);

  return rowShell(node, m('button.network-row', {
    type: 'button',
    onclick: () => selectNode(node, true),
  }, [
    m('span.network-dot', { style: 'background: ' + nodeColor(node) }),
    m('span.network-row-main', [
      m('span.network-row-name', nodeName(node)),
      m('span.network-row-sub', [
        edgeRelationship(edge, node),
        cM === null ? '' : cM + ' cM',
      ].filter(Boolean).join(' · ')),
      haplogroupLine(node.person),
    ]),
  ]));
}

function matchRow(node) {
  const cM = cmFromProportion(node.person.ibd_proportion);

  return rowShell(node, m('button.network-row', {
    type: 'button',
    onclick: () => selectNode(node, true),
  }, [
    m('span.network-dot', { style: 'background: ' + nodeColor(node) }),
    m('span.network-row-main', [
      m('span.network-row-name', nodeName(node)),
      m('span.network-row-sub', [
        node.pairCount + (node.pairCount === 1 ? ' relative' : ' relatives'),
        cM === null ? '' : cM + ' cM with profile',
      ].filter(Boolean).join(' · ')),
    ]),
    m('span.network-row-kind', 'match'),
  ]));
}

function overviewPanel() {
  if (state.loading) {
    return m('p.network-panel-empty', 'Loading saved network…');
  }

  const top = (state.adjacency.get(OWNER_ID) || [])
    .filter(({ node }) => nameMatchesSearch(node.person, state.filters.name))
    .slice(0, 18);
  const connectors = state.nodes
    .filter((node) => node.kind === 'match'
      && nameMatchesSearch(node.person, state.filters.name))
    .sort((a, b) => (b.pairCount - a.pairCount) || ((b.ibd ?? 0) - (a.ibd ?? 0)))
    .slice(0, 10);

  return [
    m('div.network-panel-head', [
      m('div', [
        m('h2', profileName || 'Profile'),
        m('p.network-panel-sub', [
          state.stats.relatives + (state.stats.relatives === 1 ? ' relative' : ' relatives'),
          state.stats.matches > 0
            ? state.stats.matches + ' ' + (state.stats.matches === 1 ? 'match' : 'matches')
            : '',
        ].filter(Boolean).join(' · ')),
      ]),
    ]),
    m('p.network-help', 'Drag to pan, scroll to zoom, and click a node for details. Drag a node to pin it.'),
    m('p.network-help', 'Distance from the center follows direct sharing with the profile on a log scale; shared links shorten as relatives share more DNA with each other.'),
    state.stats.shared > 0
      ? m('p.network-help', state.stats.shared + ' shared '
        + (state.stats.shared === 1 ? 'link' : 'links')
        + (state.stats.oneSided > 0
          ? ' · ' + state.stats.confirmed + ' confirmed · '
            + state.stats.oneSided + ' one-sided (dotted)'
          : ' · all confirmed'))
      : null,
    state.stats.shared === 0 && state.stats.relatives > 0
      ? (graphFiltersActive()
        ? m('p.network-help', 'No shared links among the relatives matching these filters.')
        : m('p.network-help.network-hint-block', 'No links between relatives yet. Use Start on the relatives page to add them.'))
      : null,
    state.stats.shared > 0
      ? m('p.network-help', 'Showing the ' + featuredEdges.size
        + ' strongest shared links. Hover a relative to see all of its links.')
      : null,
    top.length
      ? [
          m('h3.network-section-title', 'Closest relatives'),
          m('div.network-list', top.map(({ node, edge }) => personRow(node, edge))),
        ]
      : m('p.network-panel-empty', filtersActive()
        ? 'No relatives match these filters.'
        : state.notice || 'No relatives saved for this profile.'),
    connectors.length
      ? [
          m('h3.network-section-title', 'Top connectors'),
          m('div.network-list', connectors.map(matchRow)),
        ]
      : null,
    m('div.network-legend', [
      m('span.network-legend-item', [m('span.network-legend-line.owner'), 'shared with profile']),
      m('span.network-legend-item', [m('span.network-legend-line.shared'), 'shared links']),
      state.stats.oneSided > 0
        ? m('span.network-legend-item', [m('span.network-legend-line.oneway'), 'one-sided'])
        : null,
      state.stats.matches > 0
        ? m('span.network-legend-item', [m('span.network-legend-dot'), 'common match'])
        : null,
    ]),
  ];
}

function stat(value, label) {
  return m('div.network-stat', { title: value + ' ' + label }, [
    m('span.network-stat-value', value),
    m('span.network-stat-label', label),
  ]);
}

function detailStats(node, connections) {
  const count = connections === 1 ? 'link' : 'links';
  if (node.kind === 'owner') return m('div.network-stats', [stat(connections, count)]);

  const cM = cmFromProportion(node.person.ibd_proportion);
  const segments = numberValue(node.person.num_segments);

  return m('div.network-stats', [
    stat(cM === null ? '—' : cM + ' cM', 'shared DNA'),
    stat(segments === null ? '—' : segments, segments === 1 ? 'segment' : 'segments'),
    stat(connections, count),
  ]);
}

function detailPanel(node) {
  const isOwner = node.kind === 'owner';
  // The profile sits at the centre of every relative's links, but it is not
  // one of that relative's connected relatives. Its direct sharing is already
  // shown in the stat strip above.
  const links = (state.adjacency.get(node.id) || [])
    .filter(({ node: other }) => isOwner || other.id !== OWNER_ID);
  const shown = links.slice(0, 80);
  const url = isOwner ? ownProfileUrl(profileId) : profileUrl(profileId, node.id);
  const linkLabel = isOwner
    ? 'Open profile on 23andMe'
    : 'Open ' + nodeName(node) + ' on 23andMe';

  return [
    m('div.network-detail-head', [
      m('span.network-avatar', { style: 'background: ' + nodeColor(node) }, nodeInitials(node)),
      m('div.network-detail-title', [
        m('h2.network-detail-name', [
          m('span.network-detail-name-text', nodeName(node)),
          url
            ? m('a.network-row-link.network-name-link', {
                href: url,
                target: '_blank',
                rel: 'noopener noreferrer',
                title: linkLabel,
                'aria-label': linkLabel,
              }, externalIcon())
            : null,
        ]),
        m('p.network-panel-sub', nodeSubtitle(node)),
      ]),
      m('button.network-close', {
        type: 'button',
        title: 'Back to overview',
        'aria-label': 'Back to overview',
        onclick: () => selectNode(null),
      }, '×'),
    ]),

    detailStats(node, links.length),

    links.length
      ? [
          m('h3.network-section-title', isOwner ? 'Relatives' : 'Connected relatives'),
          m('div.network-list', shown.map(({ node: other, edge }) => personRow(other, edge))),
          links.length > shown.length
            ? m('p.network-panel-empty', '+' + (links.length - shown.length) + ' more connections')
            : null,
        ]
      : m('p.network-panel-empty', isOwner
        ? 'No saved connections for this person yet.'
        : 'No links to other relatives yet.'),
  ];
}

function networkSidebar() {
  const node = selectedNode();
  return m('aside.network-sidebar', node ? detailPanel(node) : overviewPanel());
}

function searchIcon() {
  return m('svg.network-filter-icon', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }, [
    m('circle', { cx: '11', cy: '11', r: '7' }),
    m('path', { d: 'm20 20-3.5-3.5' }),
  ]);
}

function funnelIcon() {
  return m('svg.network-filter-funnel', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }, m('path', { d: 'M4 5h16l-6 7v5l-4 2v-7z' }));
}

function cmInput(kind, label) {
  return m('input.network-filter-cm.browser-default', {
    type: 'number',
    min: '0',
    step: '10',
    inputmode: 'numeric',
    placeholder: kind === 'min' ? 'Min' : 'Max',
    value: state.filters[kind === 'min' ? 'minCM' : 'maxCM'],
    'aria-label': label,
    oninput: (event) => {
      state.filters[kind === 'min' ? 'minCM' : 'maxCM'] = event.target.value;
      scheduleFilterApply();
    },
  });
}

function isFemale(person) {
  const sex = String((person && person.sex) || '').trim().toLowerCase();
  return sex === 'female' || sex === 'f';
}

function haplogroupOptions(kind) {
  const values = new Set();

  for (const relative of rawData.relatives || []) {
    // Females have no Y chromosome, so their rows never feed the Y-DNA menu.
    if (kind === 'paternal' && isFemale(relative)) continue;

    const value = relative && relative.haplogroups && relative.haplogroups[kind];
    if (value) values.add(String(value).trim());
  }

  return [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// Typing here filters the graph at the same time as it narrows the menu.
function haploSearchInput(kind, placeholder, label) {
  return m('input.network-filter-haplo.browser-default', {
    type: 'search',
    placeholder,
    value: state.filters[kind] || '',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': label,
    oninput: (event) => {
      state.filters[kind] = event.target.value;
      m.redraw.sync();
      scheduleFilterApply();
    },
  });
}

function haploSelect(kind, placeholder) {
  const value = state.filters[kind] || '';
  const needle = String(value).trim().toLowerCase();
  const all = haplogroupOptions(kind);

  // Narrow the menu to values beginning with the search text. The selected
  // value stays visible even when it is only a partial search.
  let options = needle
    ? all.filter((option) => option.toLowerCase().startsWith(needle))
    : all;

  if (value && !options.includes(value)) options = [value, ...options];

  return m('select.network-filter-haplo.browser-default', {
    value,
    'aria-label': 'Select a ' + (kind === 'maternal' ? 'mtDNA' : 'Y-DNA') + ' haplogroup',
    onchange: (event) => {
      state.filters[kind] = event.target.value;
      applyFilters();
    },
  }, [
    m('option', { key: 'any', value: '', selected: value === '' }, placeholder),
    ...options.map((option) => m('option', {
      key: option,
      value: option,
      selected: option === value,
    }, option)),
  ]);
}

function activeFilterCount() {
  let count = 0;
  if (String(state.filters.name || '').trim()) count += 1;
  if (numberValue(state.filters.minCM) !== null || numberValue(state.filters.maxCM) !== null) count += 1;
  if (String(state.filters.maternal || '').trim() || String(state.filters.paternal || '').trim()) {
    count += 1;
  }
  return count;
}

// Close the popover when the pointer lands outside it.
function closeFilterMenu(event) {
  const menu = document.querySelector('.network-filter-menu');
  if (menu && menu.open && !menu.contains(event.target)) menu.open = false;
}

function closeFilterMenuOnEscape(event) {
  if (event.key !== 'Escape') return;

  const menu = document.querySelector('.network-filter-menu');
  if (menu && menu.open) menu.open = false;
}

function filterMenu() {
  if (state.loading || !profileId) return null;

  const active = filtersActive();
  const activeCount = activeFilterCount();
  const total = state.stats.totalRelatives;
  // The name search only narrows the side lists, so count the relatives that
  // remain in those lists.
  const shown = state.nodes
    .filter((node) => node.kind === 'relative'
      && nameMatchesSearch(node.person, state.filters.name))
    .length;

  return m('details.network-filter-menu', {
    oncreate: () => {
      document.addEventListener('pointerdown', closeFilterMenu);
      document.addEventListener('keydown', closeFilterMenuOnEscape);
    },
    onremove: () => {
      document.removeEventListener('pointerdown', closeFilterMenu);
      document.removeEventListener('keydown', closeFilterMenuOnEscape);
    },
  }, [
    m('summary.network-filter-trigger', {
      class: active ? 'network-filter-trigger active' : 'network-filter-trigger',
      title: 'Filter relatives by full name or last name, shared cM, or haplogroup',
    }, [
      funnelIcon(),
      m('span', 'Filter'),
      activeCount
        ? m('span.network-filter-badge', activeCount)
        : null,
      m('span.network-filter-caret', { 'aria-hidden': 'true' }, '▾'),
    ]),

    m('div.network-filter-panel', { role: 'search', 'aria-label': 'Filter relatives' }, [
      m('label.network-filter-field', [
        m('span.network-filter-label', 'Full name or last name'),
        m('div.network-filter-search', [
          searchIcon(),
          m('input.network-filter-name.browser-default', {
            type: 'search',
            placeholder: 'Search full name or last name',
            value: state.filters.name,
            autocomplete: 'off',
            spellcheck: 'false',
            'aria-label': 'Filter relatives by full name or last name',
            oninput: (event) => {
              state.filters.name = event.target.value;
              // The name filter only changes the lists, so the graph does not
              // need to be rebuilt (and the current node selection stays put).
              m.redraw.sync();
            },
          }),
        ]),
      ]),
      m('div.network-filter-field', [
        m('span.network-filter-label', 'Shared cM'),
        m('div.network-filter-range', [
          cmInput('min', 'Minimum shared cM'),
          m('span.network-filter-dash', '–'),
          cmInput('max', 'Maximum shared cM'),
          m('span.network-filter-unit', 'cM'),
        ]),
      ]),
      m('div.network-filter-field', [
        m('span.network-filter-label.network-filter-label-haplo', 'mtDNA'),
        m('div.network-filter-haplo-row', [
          haploSearchInput('maternal', 'Search mtDNA', 'Search mtDNA haplogroups'),
          haploSelect('maternal', 'Any mtDNA'),
        ]),
      ]),
      m('div.network-filter-field', [
        m('span.network-filter-label.network-filter-label-haplo', 'Y-DNA'),
        m('div.network-filter-haplo-row', [
          haploSearchInput('paternal', 'Search Y-DNA', 'Search Y-DNA haplogroups'),
          haploSelect('paternal', 'Any Y-DNA'),
        ]),
      ]),
      m('div.network-filter-footer', [
        m('span.network-filter-count', active
          ? shown + ' of ' + total + (total === 1 ? ' relative' : ' relatives')
          : total + (total === 1 ? ' relative' : ' relatives')),
        m('button.network-filter-clear', {
          type: 'button',
          disabled: !active,
          onclick: clearFilters,
        }, 'Clear'),
      ]),
    ]),
  ]);
}

const App = {
  view() {
    const subtitle = profileName || 'No profile selected';
    document.title = profileName ? 'Shared DNA Network — ' + profileName : 'Shared DNA Network';

    return [
      appHeader({
        title: 'Shared DNA Network',
        subtitle,
        actions: [
          m('a.btn-flat.waves-effect', {
            href: pageUrl('index.html'),
          }, 'Back to relatives'),
        ],
      }),

      m('main.container.network-container', [
        m('section.card.network-card', [
          m('div.network-toolbar', [
            m('div.network-summary', [
              m('span.network-count', state.loading
                ? 'Loading network…'
                : state.stats.relatives + (state.stats.relatives === 1 ? ' relative' : ' relatives')
                  + (state.stats.matches > 0
                    ? ' · ' + state.stats.matches + ' ' + (state.stats.matches === 1 ? 'match' : 'matches')
                    : '')),
              m('span.network-hint', 'Drag to pan · scroll to zoom · hover for links'),
            ]),
            m('div.network-tools', [
              filterMenu(),
              m('button', {
                type: 'button',
                class: state.includeSharedMatches
                  ? 'btn-flat btn-small waves-effect active'
                  : 'btn-flat btn-small waves-effect',
                'aria-pressed': state.includeSharedMatches ? 'true' : 'false',
                title: 'Include shared matches seen under at least two relatives',
                onclick: toggleSharedMatches,
              }, 'Shared matches'),
              m('button.btn-flat.btn-small.waves-effect', {
                type: 'button',
                onclick: fitView,
              }, 'Fit'),
              m('button.network-zoom-btn.btn-flat.btn-small.waves-effect', {
                type: 'button',
                title: 'Zoom out',
                'aria-label': 'Zoom out',
                onclick: () => zoomBy(1 / 1.3),
              }, '−'),
              m('button.network-zoom-btn.btn-flat.btn-small.waves-effect', {
                type: 'button',
                title: 'Zoom in',
                'aria-label': 'Zoom in',
                onclick: () => zoomBy(1.3),
              }, '+'),
              m('button', {
                type: 'button',
                class: state.labels ? 'btn-flat btn-small waves-effect active' : 'btn-flat btn-small waves-effect',
                'aria-pressed': state.labels ? 'true' : 'false',
                onclick: () => {
                  state.labels = !state.labels;
                  m.redraw.sync();
                  draw();
                },
              }, 'Labels'),
            ]),
          ]),

          m('div.network-body', [
            m('div.network-stage', [
              m('canvas#networkCanvas', {
                role: 'img',
                'aria-label': 'Interactive network of IBD connections between relatives',
                oncreate: setupCanvas,
                onremove: teardownCanvas,
                onupdate: () => {
                  if (preferences.hideNames !== view.lastHideNames) {
                    view.lastHideNames = preferences.hideNames;
                    hideTooltip();
                  }
                  draw();
                },
              }),
              m('div.network-tooltip.hidden', {
                oncreate: (vnode) => { view.tooltip = vnode.dom; },
              }),
              state.loading || state.notice
                ? m('div.network-empty', [
                    m('p', state.loading ? 'Loading saved network…' : state.notice),
                    !state.loading && !profileId
                      ? m('a.btn.btn-small', { href: pageUrl('index.html') }, 'Choose a profile')
                      : null,
                  ])
                : null,
            ]),
            networkSidebar(),
          ]),
        ]),
      ]),
    ];
  },
};

m.mount(document.getElementById('app'), App);
loadNetwork();
