/*
 * Relatedness matrix page
 *
 * Reads one profile's saved relatives and relatives-in-common data, builds a
 * pairwise relatedness graph, and shows it as a matrix plus family-group
 * networks. All data comes from IndexedDB; this page makes no requests.
 */

import { matrixState as state } from './state.js';
import { getSavedRelatives, getProfileRelativesInCommon } from './db.js';
import { avatar, displayName, profileUrl } from './person.js';
import { formatRelationship } from './relationships.js';
import {
  buildRelatednessModel,
  applyOverlapClusters,
  sharedMatchOverlap,
  sharedMatches,
  numberValue,
  relationshipOf,
  pairKey,
} from './relatedness.js';

const params = new URLSearchParams(location.search);
state.ownerId = params.get('profile') || '';
state.ownerName = params.get('profile_name') || state.ownerId || 'Selected profile';

// A 1500 × 1500 matrix is far too large to render. The default view is 50
// people; larger options are available with a warning.
const MAX_MATRIX_PEOPLE = 500;

const CLUSTER_COLORS = [
  '#5b8def',
  '#a855f7',
  '#34d399',
  '#f59e0b',
  '#f472b6',
  '#22d3ee',
  '#f87171',
  '#a3e635',
];

/* ---------- Formatting ---------- */

function textValue(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function fullName(person) {
  if (!person) return 'Unknown';
  if (person.isOwner) return state.ownerName || 'You';

  const name = displayName(person);
  return name && name !== '—' ? name : person.id;
}

function shortName(person) {
  if (!person) return '—';
  if (person.isOwner) return 'You';

  const first = textValue(person.first_name) || textValue(person.first_initial);
  const last = textValue(person.last_name) || textValue(person.last_initial);

  if (first && last) return first + ' ' + last.charAt(0) + '.';

  const name = displayName(person);
  if (name && name !== '—') return name.length > 16 ? name.slice(0, 15) + '…' : name;
  return person.id.length > 12 ? '…' + person.id.slice(-10) : person.id;
}

function rowName(person) {
  if (!person) return 'Unknown';
  if (person.isOwner) return 'You';

  const name = displayName(person);
  return name && name !== '—' ? name : person.id;
}

function formatPercent(value) {
  const number = numberValue(value);
  if (number === null) return '—';

  // Keep two decimal places even for large values, so 49.97% is not rounded
  // to 50%. Trailing zeros are removed by Number().
  return Number((number * 100).toFixed(2)) + '%';
}

function formatSegments(value) {
  const number = numberValue(value);
  return number === null ? '—' : countLabel(number, 'segment', 'segments');
}

function segmentsShort(value) {
  const number = numberValue(value);
  return number === null ? '' : number + ' seg';
}

function metricValueFromEdge(edge) {
  return state.metric === 'segments' ? edge.segments : edge.proportion;
}

function metricMax(model) {
  return state.metric === 'segments'
    ? Math.max(1, model.stats.maxSegments || 1)
    : 0.5;
}

function metricLabel(value) {
  return state.metric === 'segments' ? String(value) : formatPercent(value);
}

function ibdTitle(proportion, segments) {
  const parts = [];

  if (proportion !== null) parts.push(formatPercent(proportion) + ' IBD');
  if (segments !== null) parts.push(countLabel(segments, 'segment', 'segments'));

  return parts.length ? parts.join(' · ') : 'No IBD value saved';
}

function ibdCell(proportion, segments) {
  const parts = [];

  if (state.metric === 'segments') {
    if (segments !== null) parts.push(segmentsShort(segments));
    if (proportion !== null) parts.push(formatPercent(proportion));
  } else {
    if (proportion !== null) parts.push(formatPercent(proportion));
    if (segments !== null) parts.push(segmentsShort(segments));
  }

  return parts.length ? parts.join(' · ') : '—';
}

function countLabel(count, singular, pluralForm) {
  return count + ' ' + (count === 1 ? singular : pluralForm);
}

function clusterColor(cluster) {
  if (!cluster) return '';
  return CLUSTER_COLORS[(cluster.index - 1) % CLUSTER_COLORS.length];
}

function clusterOfPerson(model, person) {
  if (!model || !person || !person.cluster) return null;
  return model.clustersById.get(person.cluster) || null;
}

function edgeFor(model, aId, bId) {
  if (!model) return null;
  return model.edgesByKey.get(pairKey(aId, bId)) || null;
}

function isSelectedPair(aId, bId) {
  const selected = state.selected;
  if (!selected) return false;
  return (selected.a === aId && selected.b === bId)
    || (selected.a === bId && selected.b === aId);
}

function pageUrl(name) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(name);
  }
  return name;
}

function linkedPerson(person, content) {
  if (!person || person.isOwner) return content;

  const url = profileUrl(state.ownerId, person.id);
  if (!url) return content;

  return m('a.relative-link', {
    href: url,
    target: '_blank',
    rel: 'noopener noreferrer',
    title: 'Open this profile on 23andMe',
  }, content);
}

/* ---------- Loading ---------- */

async function load() {
  if (!state.ownerId) {
    state.loading = false;
    state.notice = 'Missing profile id. Open this page from the main relatives page.';
    m.redraw.sync();
    return;
  }

  state.loading = true;
  state.loadingText = 'Reading saved relatives…';
  state.notice = '';

  try {
    const [relatives, pairs] = await Promise.all([
      getSavedRelatives(state.ownerId),
      getProfileRelativesInCommon(state.ownerId),
    ]);

    // Let the browser paint the status before the synchronous overlap build.
    state.loadingText = 'Building family groups…';
    m.redraw.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));

    state.model = buildRelatednessModel({
      ownerId: state.ownerId,
      relatives,
      pairs,
      minOverlap: Number(state.minOverlap) || 3,
    });

    if (state.cluster !== 'all' && !state.model.clustersById.has(state.cluster)) {
      state.cluster = 'all';
    }

    // With no relative-to-relative links there is nothing to hide, so show
    // the direct owner links instead of an empty network-only matrix.
    if (state.model.stats.clusterCount === 0) state.networkOnly = false;

    if (!state.model.stats.hasSegments) state.metric = 'proportion';

    if (state.model.stats.totalPeople <= 1) {
      state.notice = 'No saved relatives for this profile. Load its DNA relatives on the main page first.';
    } else if (state.model.stats.savedPairs === 0) {
      state.notice = 'No relatives-in-common comparisons are saved yet. The matrix only shows direct links to the selected profile. Use “Get relatives in common” on the main page, then reload this page.';
    }

    document.title = 'Relatedness Matrix — ' + (state.ownerName || state.ownerId);
  } catch (err) {
    console.warn('Could not build the relatedness matrix', err);
    state.notice = 'Could not read the local database.';
  } finally {
    state.loading = false;
    m.redraw.sync();
  }
}

/* ---------- Interaction ---------- */

function selectPair(aId, bId) {
  if (!aId || !bId || aId === bId) return;

  state.selected = { a: aId, b: bId };
  m.redraw.sync();

  const panel = document.getElementById('pair-details');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetFilters() {
  state.query = '';
  state.networkOnly = false;
  state.minOverlap = '3';
  state.cluster = 'all';
  state.maxPeople = '50';

  if (state.model) applyOverlapClusters(state.model, 3);
}

/* ---------- Matrix selection ---------- */

function visiblePeople(model) {
  let list = model.people.filter((person) => !person.isOwner);

  if (state.cluster !== 'all') {
    list = list.filter((person) => person.cluster === state.cluster);
  } else if (state.networkOnly) {
    list = list.filter((person) => person.cluster);
  }

  const query = state.query.trim().toLowerCase();

  if (query) {
    list = list.filter((person) => {
      const name = fullName(person).toLowerCase();
      const id = person.id.toLowerCase();
      const initials = textValue(person.initials).toLowerCase();
      return name.includes(query) || id.includes(query) || initials.includes(query);
    });
  }

  const eligible = list.length;
  const requested = Number(state.maxPeople);
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_MATRIX_PEOPLE)
    : MAX_MATRIX_PEOPLE;

  list = list.slice(0, limit);

  return { people: list, eligible, shown: list.length, limit };
}

function matrixMeta(model, selection) {
  const parts = [
    selection.shown + ' of ' + selection.eligible
      + (selection.eligible === 1 ? ' person' : ' people'),
  ];

  if (state.cluster !== 'all') {
    const cluster = model.clustersById.get(state.cluster);
    if (cluster) parts.push('family group ' + cluster.index);
  } else if (state.networkOnly) {
    parts.push('in family groups');
  } else if (model.stats.clusterCount) {
    parts.push(model.stats.clusterCount + ' family group'
      + (model.stats.clusterCount === 1 ? '' : 's'));
  }

  const query = state.query.trim();
  if (query) parts.push('matching “' + query + '”');

  parts.push(model.stats.networkEdges + ' pairwise link'
    + (model.stats.networkEdges === 1 ? '' : 's'));

  return parts.join(' · ');
}

function heatIntensity(value, model) {
  const number = numberValue(value);
  if (number === null) return null;

  const max = metricMax(model);
  return Math.sqrt(Math.max(0, Math.min(number, max)) / max);
}

function heatStyle(value, model) {
  const intensity = heatIntensity(value, model);
  if (intensity === null) return {};

  const alpha = 0.08 + 0.74 * intensity;
  return { background: 'rgba(91, 141, 239, ' + alpha.toFixed(2) + ')' };
}

function heatClass(value, model) {
  const intensity = heatIntensity(value, model);
  return intensity !== null && intensity > 0.48 ? 'm-strong' : '';
}

function directIbdSummary(person) {
  const parts = [];

  if (person.directProportion !== null) {
    parts.push(formatPercent(person.directProportion) + ' IBD');
  }
  if (person.directSegments !== null) {
    parts.push(person.directSegments + ' seg');
  }

  return parts.length ? parts.join(' · ') : person.id;
}

function cellTitle(model, row, column, edge) {
  const rowLabel = fullName(row);
  const columnLabel = fullName(column);
  const parts = [rowLabel + ' ↔ ' + columnLabel];

  if (edge.proportion !== null || edge.segments !== null) {
    parts.push(ibdTitle(edge.proportion, edge.segments));
  }

  const rowRelationship = relationshipOf(edge, row.id, column.id);
  const columnRelationship = relationshipOf(edge, column.id, row.id);

  if (rowRelationship) {
    parts.push(columnLabel + ' is ' + rowLabel + '’s ' + formatRelationship(rowRelationship));
  }
  if (columnRelationship) {
    parts.push(rowLabel + ' is ' + columnLabel + '’s ' + formatRelationship(columnRelationship));
  }
  if (!rowRelationship && !columnRelationship) {
    parts.push('No relationship prediction saved');
  }

  if (edge.observations > 1) {
    parts.push(edge.observations + ' saved observations');
  }

  parts.push('Click for shared matches and IDs');
  return parts.join('\n');
}

function matrixCell(model, row, column) {
  if (row.id === column.id) {
    return m('td.m-cell.m-diag', { title: rowName(row) + ' (same person)' }, 'self');
  }

  const edge = edgeFor(model, row.id, column.id);
  if (!edge) return m('td.m-cell.m-empty');

  const value = metricValueFromEdge(edge);
  const hasValue = value !== null;
  const classes = ['m-cell'];

  if (hasValue) classes.push('m-lit', heatClass(value, model));
  else classes.push('m-rel-only');
  if (isSelectedPair(row.id, column.id)) classes.push('m-selected');

  return m('td', {
    class: classes.join(' '),
    style: heatStyle(value, model),
    title: cellTitle(model, row, column, edge),
    onclick: () => selectPair(row.id, column.id),
  }, hasValue ? metricLabel(value) : '—');
}

function rowHeader(model, person) {
  const cluster = clusterOfPerson(model, person);
  const sub = person.isOwner ? 'Selected profile' : directIbdSummary(person);
  const title = fullName(person) + ' · ' + person.id
    + (cluster ? ' · family group ' + cluster.index : '');

  return m('th.matrix-row', {
    scope: 'row',
    title,
  }, m('div.matrix-person', [
    avatar(person),
    m('div.matrix-person-text', [
      m('span.matrix-person-name', rowName(person)),
      m('span.matrix-person-sub', [
        cluster
          ? m('span.cluster-dot', { style: { background: clusterColor(cluster) } })
          : null,
        cluster ? m('span.matrix-group-code', 'G' + cluster.index) : null,
        sub,
      ]),
    ]),
  ]));
}

function columnHeader(model, person) {
  const cluster = clusterOfPerson(model, person);

  return m('th.matrix-col', {
    scope: 'col',
    title: fullName(person) + ' · ' + person.id,
    style: cluster ? { borderTopColor: clusterColor(cluster) } : {},
  }, m('span.matrix-col-name', shortName(person)));
}

function buildMatrixGroups(model, people) {
  const groups = [];

  for (const person of people) {
    const key = person.isOwner
      ? 'owner'
      : person.cluster ? 'c:' + person.cluster : 'ungrouped';

    let group = groups[groups.length - 1];

    if (!group || group.key !== key) {
      group = {
        key,
        isOwner: Boolean(person.isOwner),
        cluster: person.isOwner ? null : clusterOfPerson(model, person),
        people: [],
      };
      groups.push(group);
    }

    group.people.push(person);
  }

  return groups;
}

function groupHeadCell(group) {
  if (group.isOwner) {
    return m('th.matrix-group-head.owner', {
      colspan: group.people.length,
      scope: 'colgroup',
    }, m('span.matrix-group-title', 'Selected'));
  }

  const cluster = group.cluster;
  const color = cluster ? clusterColor(cluster) : '';
  const visible = group.people.length;
  const total = cluster ? cluster.members.length : visible;
  const title = cluster ? 'Family group ' + cluster.index : 'No family group';
  const count = visible === total
    ? countLabel(total, 'person', 'people')
    : visible + ' of ' + total;

  return m('th.matrix-group-head', {
    colspan: visible,
    scope: 'colgroup',
    class: cluster ? '' : 'ungrouped',
    title: title + ' · ' + count,
    style: cluster ? { borderBottomColor: color } : {},
  }, [
    cluster ? m('span.cluster-dot', { style: { background: color } }) : null,
    m('span.matrix-group-title', title),
    m('span.matrix-group-count', count),
  ]);
}

function matrixGroupRow(model, group, columnCount) {
  const cluster = group.cluster;
  const color = cluster ? clusterColor(cluster) : '';
  const visible = group.people.length;
  const total = cluster ? cluster.members.length : visible;
  const label = cluster ? 'Family group ' + cluster.index : 'No family group';
  const count = visible === total
    ? countLabel(total, 'person', 'people')
    : visible + ' of ' + total + ' shown';
  const anchor = cluster ? model.peopleById.get(cluster.anchorId) : null;
  const anchorLabel = anchor ? ' · ' + shortName(anchor) : '';

  return m('tr.matrix-group-row', { key: 'group:' + group.key }, [
    m('th.matrix-group-label', {
      scope: 'rowgroup',
      title: label + ' · ' + count + anchorLabel,
      style: cluster ? { borderLeftColor: color } : {},
    }, [
      m('span.matrix-group-label-top', [
        cluster ? m('span.cluster-dot', { style: { background: color } }) : null,
        m('span.matrix-group-label-text', label),
      ]),
      m('span.matrix-group-label-sub', count + anchorLabel),
    ]),
    m('td.matrix-group-band', {
      colspan: columnCount,
      style: cluster
        ? {
            borderTopColor: color,
            backgroundColor: color + '14',
          }
        : {
            borderTopColor: '#2c3547',
            backgroundColor: 'rgba(108, 119, 140, 0.07)',
          },
    }),
  ]);
}

function matrixView(model) {
  const selection = visiblePeople(model);
  const people = [model.peopleById.get(model.ownerId), ...selection.people].filter(Boolean);

  const emptyMessage = state.query.trim()
    ? 'No people match “' + state.query.trim() + '”.'
    : state.cluster !== 'all'
      ? 'This family group has no people to show.'
      : state.networkOnly
        ? 'No family groups at this overlap threshold. Lower “Min shared matches” or turn off “Only network people”.'
        : 'No saved people to show.';

  return m('section.panel.matrix-panel', [
    m('div.section-head', [
      m('div', [
        m('h2', 'Pairwise IBD'),
        m('p.meta', matrixMeta(model, selection)),
      ]),
      m('button.link-button', {
        type: 'button',
        disabled: state.loading,
        onclick: load,
      }, state.loading ? 'Reloading…' : 'Reload'),
    ]),

    m('div.matrix-controls', [
      m('label.field', [
        m('span.label', 'Search'),
        m('input', {
          type: 'search',
          value: state.query,
          placeholder: 'Name or ID',
          oninput: (event) => { state.query = event.target.value; },
        }),
      ]),
      m('label.field', [
        m('span.label', 'IBD metric'),
        m('select', {
          value: state.metric,
          onchange: (event) => { state.metric = event.target.value; },
        }, [
          m('option', { value: 'proportion' }, 'IBD proportion (%)'),
          m('option', {
            value: 'segments',
            disabled: !model.stats.hasSegments,
          }, 'IBD segments'),
        ]),
      ]),
      m('label.field', {
        title: 'Minimum shared matches two relatives must have in common to be placed in the same family group.',
      }, [
        m('span.label', 'Min shared matches'),
        m('input', {
          type: 'number',
          min: '2',
          max: '65535',
          step: '1',
          value: state.minOverlap,
          disabled: !model.stats.overlapAvailable,
          style: { width: '92px' },
          onchange: (event) => {
            const requested = Number(event.target.value);
            const value = Number.isFinite(requested)
              ? Math.min(65535, Math.max(2, Math.round(requested)))
              : 3;

            state.minOverlap = String(value);
            event.target.value = state.minOverlap;
            applyOverlapClusters(model, value);
            state.cluster = 'all';
          },
        }),
      ]),
      m('label.field', [
        m('span.label', 'Family group'),
        m('select', {
          value: state.cluster,
          title: 'Family groups are relatives grouped by how many shared matches they have in common.',
          onchange: (event) => {
            state.cluster = event.target.value;
          },
        }, [
          m('option', { value: 'all' }, 'All family groups'),
          ...model.clusters.map((cluster) => m('option', {
            value: cluster.id,
          }, 'Group ' + cluster.index + ' (' + cluster.members.length + ')')),
        ]),
      ]),
      m('label.field', [
        m('span.label', 'Show'),
        m('select', {
          value: state.maxPeople,
          onchange: (event) => { state.maxPeople = event.target.value; },
        }, [
          m('option', { value: '25' }, 'First 25 people'),
          m('option', { value: '50' }, 'First 50 people'),
          m('option', { value: '100' }, 'First 100 people'),
          m('option', { value: '150' }, 'First 150 people'),
          m('option', { value: '250' }, 'First 250 people'),
          m('option', { value: '500' }, 'First 500 people'),
        ]),
      ]),
      m('label.check-field', {
        title: state.cluster !== 'all'
          ? 'A family-group filter is active, so only group members are shown.'
          : 'Hide relatives that are not in a family group.',
      }, [
        m('input', {
          type: 'checkbox',
          checked: state.networkOnly,
          disabled: state.cluster !== 'all',
          onchange: (event) => { state.networkOnly = event.target.checked; },
        }),
        m('span', 'Only network people'),
      ]),
      m('button.link-button', { type: 'button', onclick: resetFilters }, 'Reset'),
    ]),

    Number(state.maxPeople) >= 250
      ? m('p.empty-note', 'Large matrices may be slow. Use the search box or a family group to narrow the view.')
      : null,

    !model.stats.overlapAvailable
      ? m('p.empty-note', 'Overlap clustering is unavailable for this many relatives, so family groups use direct shared-match links.')
      : model.stats.clusterCount === 0
        ? m('p.empty-note', 'No family groups at ' + state.minOverlap + ' shared matches in common. Lower “Min shared matches” to group more relatives.')
        : model.stats.clusterCount === 1
          ? m('p.empty-note', 'All grouped relatives are in one family group. Raise “Min shared matches” to split it into smaller groups.')
          : null,

    m('div.matrix-legend', [
      m('span.legend-label', state.metric === 'segments' ? 'IBD segments' : 'IBD proportion'),
      m('span.legend-text', 'less'),
      m('span.legend-gradient'),
      m('span.legend-text', 'more'),
      m('span.legend-note', 'IBD = identical by descent. Click a filled cell for details; an empty cell has no saved link, and a dash has no value for the selected metric.'),
    ]),

    selection.shown > 0
      ? (() => {
          const groups = buildMatrixGroups(model, people);
          const hasGroups = groups.some((group) => group.cluster);

          const corner = m('th.matrix-corner', {
            scope: 'col',
            rowspan: hasGroups ? 2 : undefined,
          }, [
            m('span.matrix-corner-title', 'Person'),
            m('span.matrix-corner-sub', 'IBD · row → column'),
          ]);

          const head = hasGroups
            ? [
                m('tr.matrix-group-head-row', [
                  corner,
                  ...groups.map((group) => groupHeadCell(group)),
                ]),
                m('tr.matrix-person-head-row',
                  people.map((person) => columnHeader(model, person))),
              ]
            : m('tr', [
                corner,
                ...people.map((person) => columnHeader(model, person)),
              ]);

          const bodyRows = [];

          for (const group of groups) {
            if (hasGroups && !group.isOwner) {
              bodyRows.push(matrixGroupRow(model, group, people.length));
            }

            for (const row of group.people) {
              bodyRows.push(m('tr', { key: row.id }, [
                rowHeader(model, row),
                ...people.map((column) => matrixCell(model, row, column)),
              ]));
            }
          }

          return m('div.matrix-wrap', m('table.matrix-table', {
            'aria-label': 'Pairwise IBD matrix',
            title: 'Rows and columns are grouped by family group. Groups are based on shared-match overlap.',
          }, [
            m('thead', head),
            m('tbody', bodyRows),
          ]));
        })()
      : m('div.matrix-empty', [
          m('p', emptyMessage),
          state.networkOnly && !state.query.trim() && state.cluster === 'all'
            ? m('button.link-button', {
                type: 'button',
                onclick: () => { state.networkOnly = false; },
              }, 'Show every relative')
            : null,
        ]),

    m('p.footnote', 'IBD is only as complete as the comparisons saved on the main page.'),
  ]);
}

/* ---------- Pair details ---------- */

function personCard(model, person) {
  const isOwner = person.isOwner;
  const cluster = clusterOfPerson(model, person);
  const parts = [];

  if (!isOwner) {
    if (person.directProportion !== null) parts.push(formatPercent(person.directProportion) + ' IBD');
    if (person.directSegments !== null) parts.push(formatSegments(person.directSegments));
    if (person.directRelationship) parts.push(formatRelationship(person.directRelationship));
  }

  const details = isOwner
    ? 'Selected profile'
    : parts.length ? parts.join(' · ') : 'No direct IBD saved';

  return m('div.person-card', [
    avatar(person),
    m('div.person-card-body', [
      m('div.person-card-name', linkedPerson(person, fullName(person))),
      m('code.person-id', person.id),
      m('div.person-card-sub', details),
      isOwner ? null : m('div.person-card-group', [
        cluster
          ? m('span.cluster-dot', { style: { background: clusterColor(cluster) } })
          : null,
        cluster ? 'Family group ' + cluster.index : 'No family group',
      ]),
    ]),
  ]);
}

function metric(label, value) {
  return m('div.metric', [
    m('div.metric-value', value),
    m('div.metric-label', label),
  ]);
}

// Describes the relationship of `subject` to `observer`, avoiding "You's".
function relationshipLabel(subject, observer) {
  if (observer.isOwner) return shortName(subject) + '’s relationship to you';
  if (subject.isOwner) return 'Your relationship to ' + shortName(observer);
  return shortName(subject) + '’s relationship to ' + shortName(observer);
}

function matchPersonCell(person) {
  const content = [
    avatar(person),
    m('span.relative-name', fullName(person)),
  ];

  return m('div.match-person', [
    linkedPerson(person, m('div.relative', content)),
    m('code.match-id', person.id),
  ]);
}

function relationColumn(short) {
  return short === 'You' ? 'To you' : 'To ' + short;
}

function sharedColumn(short) {
  return short === 'You' ? 'IBD with you' : 'IBD with ' + short;
}

function sharedMatchesView(model, a, b) {
  const aShort = shortName(a);
  const bShort = shortName(b);
  const result = sharedMatches(model, a.id, b.id);

  if (!result.available) {
    let message = 'Shared matches are not available.';

    if (result.reason === 'missing-pair') {
      const missing = model.peopleById.get(result.missingIds[0]);
      message = 'No relatives-in-common list is saved for '
        + (missing ? fullName(missing) : result.missingIds[0])
        + '. Fetch it on the main page first.';
    } else if (result.reason === 'missing-both-pairs') {
      const names = result.missingIds.map((id) => {
        const person = model.peopleById.get(id);
        return person ? fullName(person) : id;
      });
      message = 'Shared matches need saved relatives-in-common lists for both people. Missing: '
        + names.join(', ') + '.';
    } else if (result.reason === 'same-person') {
      message = 'Pick two different people.';
    }

    return m('div.shared-matches', [
      m('h3', 'Shared matches'),
      m('p.empty-note', message),
    ]);
  }

  if (result.matches.length === 0) {
    return m('div.shared-matches', [
      m('h3', 'Shared matches (0)'),
      m('p.empty-note', 'No shared matches were found in the saved lists.'),
    ]);
  }

  return m('div.shared-matches', [
    m('h3', 'Shared matches (' + result.matches.length + ')'),
    m('div.table-wrap.matches-wrap', m('table.relatives-table.matches-table', [
      m('thead', m('tr', [
        m('th', 'Shared match'),
        m('th', relationColumn(aShort)),
        m('th', sharedColumn(aShort)),
        m('th', relationColumn(bShort)),
        m('th', sharedColumn(bShort)),
      ])),
      m('tbody', result.matches.map((match) => {
        const person = match.person || { id: match.id };

        return m('tr', { key: match.id }, [
          m('td', matchPersonCell(person)),
          m('td', formatRelationship(match.relToA)),
          m('td.dna', ibdCell(match.ibdToA, match.segmentsToA)),
          m('td', formatRelationship(match.relToB)),
          m('td.dna', ibdCell(match.ibdToB, match.segmentsToB)),
        ]);
      })),
    ])),
  ]);
}

function detailsView(model) {
  if (!state.selected) return null;

  const a = model.peopleById.get(state.selected.a);
  const b = model.peopleById.get(state.selected.b);
  if (!a || !b) return null;

  const edge = edgeFor(model, a.id, b.id);
  // relationshipOf(edge, observer, subject) describes the subject's
  // relationship to the observer.
  const bRelToA = relationshipOf(edge, a.id, b.id);
  const aRelToB = relationshipOf(edge, b.id, a.id);
  const overlap = sharedMatchOverlap(model, a.id, b.id);

  return m('section.panel.pair-details', { id: 'pair-details' }, [
    m('div.section-head', [
      m('div', [
        m('h2', 'Pair details'),
        m('p.meta', edge
          ? edge.observations + ' saved observation' + (edge.observations === 1 ? '' : 's')
          : 'No pairwise link saved'),
      ]),
      m('button.link-button', {
        type: 'button',
        onclick: () => { state.selected = null; },
      }, 'Close'),
    ]),

    m('div.pair-people', [
      personCard(model, a),
      m('span.pair-arrow', { 'aria-hidden': 'true' }, '↔'),
      personCard(model, b),
    ]),

    m('div.pair-metrics', [
      metric('IBD proportion', edge ? formatPercent(edge.proportion) : '—'),
      metric('IBD segments', edge ? formatSegments(edge.segments) : '—'),
      metric('Shared matches in common', overlap !== null ? String(overlap) : '—'),
      metric(relationshipLabel(b, a), bRelToA ? formatRelationship(bRelToA) : '—'),
      metric(relationshipLabel(a, b), aRelToB ? formatRelationship(aRelToB) : '—'),
    ]),

    !bRelToA && !aRelToB
      ? m('p.empty-note', 'No relationship prediction is saved for this pair.')
      : !bRelToA || !aRelToB
        ? m('p.empty-note', 'Only one direction was recorded in the saved data.')
        : null,

    overlap !== null && !a.isOwner && !b.isOwner
      ? m('p.empty-note', overlap >= Number(state.minOverlap)
          ? 'These two meet the family-group link threshold: '
            + overlap + ' shared matches in common (minimum ' + state.minOverlap + ').'
          : 'These two do not directly meet the family-group link threshold: '
            + overlap + ' shared matches in common (minimum ' + state.minOverlap + '). '
            + 'They may still be connected through other relatives.')
      : null,

    sharedMatchesView(model, a, b),
  ]);
}

/* ---------- View ---------- */

const App = {
  view() {
    const model = state.model;

    return [
      m('header.topbar', [
        m('div.brand', [
          m('div.mark', { 'aria-hidden': 'true' }, [m('span'), m('span')]),
          m('div', [
            m('h1', 'Relatedness Matrix'),
            m('p.sub', state.ownerName + (state.ownerId ? ' · ' + state.ownerId : '')),
          ]),
        ]),
        m('div.top-actions', [
          m('a.link-button', { href: pageUrl('index.html') }, 'Back to relatives'),
        ]),
      ]),

      m('main', [
        !model
          ? m('section.panel', [
              m('p.meta', state.loading
                ? [m('span.spinner'), ' ' + state.loadingText]
                : 'No relatedness data loaded.'),
            ])
          : [
              matrixView(model),
              detailsView(model),
            ],

        m('p', { class: state.notice ? 'notice' : 'notice hidden' }, state.notice),
      ]),
    ];
  },
};

m.mount(document.getElementById('app'), App);
load();
