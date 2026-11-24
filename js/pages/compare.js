/*
 * Relatives in common page
 *
 * Shows the comparison for one pair (profile + relative). The main page saves
 * it to IndexedDB, so this page only reads the database.
 */

import { compareState as state } from '../core/state.js';
import { getRelativesInCommon, getSavedRelatives } from '../data/db.js';
import { avatar, nameMatchesSearch, profileUrl } from '../core/person.js';
import { formatRelationship } from '../core/relationships.js';
import { labelName, preferences, initialsOfName } from '../core/preferences.js';
import { appHeader, pageUrl } from '../ui/header.js';

const params = new URLSearchParams(location.search);
const profileId = params.get('profile') || '';
const relativeId = params.get('relative') || '';
const profileName = params.get('profile_name') || profileId;
const relativeName = params.get('relative_name') || relativeId;

/* ---------- Helpers for one comparison entry ---------- */

// Finds every prediction index present in the saved rows, so the table shows
// Rel 1/IBD 1, Rel 2/IBD 2, and any further pairs the endpoint returns.
function relationshipIndexes(relatives) {
  const indexes = new Set();

  for (const relative of relatives) {
    for (const key of Object.keys(relative)) {
      const match = /^(?:predicted_relationship_id|ibd_proportion)_(\d+)$/.exec(key);
      if (match) indexes.add(Number(match[1]));
    }
  }

  return [...indexes].sort((a, b) => a - b);
}

/* ---------- Sorting ---------- */

function numberValue(value) {
  if (value === undefined || value === null || value === '') return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentageLabel(value) {
  const number = numberValue(value);
  if (number === null) return '—';

  return Number((number * 100).toFixed(2)) + '%';
}

// Missing values always sort last, whichever direction is selected.
function comparePresent(a, b, direction, compare) {
  const aMissing = a === null;
  const bMissing = b === null;

  if (aMissing || bMissing) {
    if (aMissing && bMissing) return 0;
    return aMissing ? 1 : -1;
  }

  return direction * compare(a, b);
}

function sortedRelatives(relatives, sort) {
  if (sort === 'saved') return relatives;

  const [, index, directionName] = sort.split(':');
  const direction = directionName === 'desc' ? -1 : 1;
  const field = 'ibd_proportion_' + index;

  return [...relatives].sort((a, b) => comparePresent(
    numberValue(a[field]),
    numberValue(b[field]),
    direction,
    (left, right) => left - right,
  ));
}

function sortDirection(index) {
  const prefix = 'ibd:' + index + ':';
  return state.sort.startsWith(prefix) ? state.sort.slice(prefix.length) : '';
}

function toggleSort(index) {
  const prefix = 'ibd:' + index + ':';
  const active = state.sort.startsWith(prefix);
  const next = active && state.sort.endsWith(':asc') ? 'desc'
    : active ? 'asc' : 'desc';

  state.sort = prefix + next;
  m.redraw.sync();
}

// The IBD headers sort the table in place: first click high to low, then the
// same header toggles low to high.
function sortableHeader(index) {
  const direction = sortDirection(index);
  const active = Boolean(direction);
  const next = active && direction === 'desc' ? 'asc' : 'desc';
  const title = 'Sort by IBD ' + index
    + (next === 'asc' ? ' (low to high)' : ' (high to low)');

  return m('th.sortable', {
    'aria-sort': active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none',
  }, m('button.sort-button', {
    type: 'button',
    title,
    'aria-label': title,
    onclick: () => toggleSort(index),
  }, [
    'IBD ' + index,
    m('span.sort-arrow', { 'aria-hidden': 'true' }, active
      ? (direction === 'asc' ? '▲' : '▼')
      : '↕'),
  ]));
}

/* ---------- Load from IndexedDB ---------- */

async function load() {
  if (profileName && relativeName) {
    state.subtitle = profileName + ' → ' + relativeName;
  } else {
    state.subtitle = '';
  }

  if (!profileId || !relativeId) {
    state.notice = 'Missing profile or relative id.';
    return;
  }

  state.loading = true;
  state.meta = 'Loading…';

  try {
    const [relatives, savedRelatives] = await Promise.all([
      getRelativesInCommon(profileId, relativeId),
      getSavedRelatives(profileId),
    ]);

    if (!relatives) {
      state.meta = '';
      state.notice = 'No saved comparison for this pair. Use "Start" on the main page first.';
      return;
    }

    const byId = new Map();
    for (const person of savedRelatives) {
      if (person && person.relative_profile_id) byId.set(String(person.relative_profile_id), person);
    }

    // The common-relative rows do not always carry the fields used by the
    // avatar. Fill them from the selected profile's saved relatives list.
    state.relatives = relatives.map((relative) => {
      const source = byId.get(String(relative.profile_id));
      if (!source) return relative;

      return {
        ...relative,
        first_name: relative.first_name || source.first_name,
        last_name: relative.last_name || source.last_name,
        first_initial: relative.first_initial || source.first_initial,
        last_initial: relative.last_initial || source.last_initial,
        initials: relative.initials || source.initials,
        sex: relative.sex || source.sex,
        profile_image_url: relative.profile_image_url || source.profile_image_url,
        haplogroups: relative.haplogroups || source.haplogroups,
      };
    });

    const indexes = relationshipIndexes(state.relatives);
    state.sort = indexes.length ? 'ibd:' + indexes[0] + ':desc' : 'saved';

    state.meta = relatives.length + ' relative' + (relatives.length === 1 ? '' : 's') + ' in common';
  } catch {
    state.meta = '';
    state.notice = 'Could not read the local database.';
  } finally {
    state.loading = false;
    m.redraw.sync();
  }
}

/* ---------- Filters ---------- */

function isFemaleRelative(relative) {
  const sex = String((relative && relative.sex) || '').trim().toLowerCase();
  return sex === 'female' || sex === 'f';
}

function relativeHaplogroups(relative) {
  const groups = (relative && relative.haplogroups) || {};
  const female = isFemaleRelative(relative);

  return {
    maternal: groups.maternal || '',
    paternal: female ? '' : (groups.paternal || ''),
    female,
  };
}

function haplogroupMatches(value, filter) {
  const needle = String(filter || '').trim().toLowerCase();
  if (!needle) return true;

  return String(value || '').trim().toLowerCase().startsWith(needle);
}

function filtersActive(filters = state.filters) {
  return Boolean(
    String(filters.name || '').trim()
    || String(filters.maternal || '').trim()
    || String(filters.paternal || '').trim(),
  );
}

function passesFilters(relative, filters = state.filters) {
  if (!nameMatchesSearch(relative, filters.name)) return false;

  const maternal = String(filters.maternal || '').trim();
  const paternal = String(filters.paternal || '').trim();
  if (maternal || paternal) {
    // Females have no Y chromosome, so a Y-DNA filter never matches them.
    const groups = relativeHaplogroups(relative);
    if (!haplogroupMatches(groups.maternal, maternal)) return false;
    if (!haplogroupMatches(groups.paternal, paternal)) return false;
  }

  return true;
}

function clearFilters() {
  state.filters.name = '';
  state.filters.maternal = '';
  state.filters.paternal = '';
}

// Haplogroups seen among the loaded relatives, for the filter menus.
function haplogroupOptions(kind) {
  const values = new Set();

  for (const relative of state.relatives) {
    if (kind === 'paternal' && isFemaleRelative(relative)) continue;

    const groups = relative && relative.haplogroups;
    const value = groups && groups[kind];
    if (value) values.add(String(value).trim());
  }

  return [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function haploFilterSelect(kind, placeholder) {
  const value = state.filters[kind] || '';
  const needle = String(value).trim().toLowerCase();
  const all = haplogroupOptions(kind);

  // Narrow the menu to values beginning with the search text. The selected
  // value stays visible even when it is only a partial search.
  let options = needle
    ? all.filter((option) => option.toLowerCase().startsWith(needle))
    : all;

  if (value && !options.includes(value)) options = [value, ...options];

  return m('select.relatives-filter-select.browser-default', {
    value,
    'aria-label': kind === 'maternal'
      ? 'Filter relatives by mtDNA haplogroup'
      : 'Filter relatives by Y-DNA haplogroup',
    onchange: (event) => {
      state.filters[kind] = event.target.value;
      m.redraw.sync();
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

function haploSearchInput(kind, placeholder, label) {
  return m('input.relatives-filter-haplo-search.browser-default', {
    type: 'search',
    placeholder,
    value: state.filters[kind] || '',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': label,
    oninput: (event) => {
      state.filters[kind] = event.target.value;
      m.redraw.sync();
    },
  });
}

function filterBar() {
  if (state.relatives.length === 0) return null;

  const active = filtersActive();
  const shown = state.relatives
    .filter((relative) => passesFilters(relative)).length;

  return m('div.relatives-filters', [
    m('label.relatives-filter-field.relatives-filter-name', [
      m('span.relatives-filter-label', 'Full name or last name'),
      m('input.relatives-filter-input.browser-default', {
        type: 'search',
        placeholder: 'Search full name or last name',
        value: state.filters.name,
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': 'Filter relatives by full name or last name',
        oninput: (event) => {
          state.filters.name = event.target.value;
          m.redraw.sync();
        },
      }),
    ]),
    m('div.relatives-filter-field', [
      m('span.relatives-filter-label.relatives-filter-label-haplo', 'mtDNA'),
      m('div.relatives-filter-haplo-row', [
        haploSearchInput('maternal', 'Search mtDNA', 'Search mtDNA haplogroups'),
        haploFilterSelect('maternal', 'Any mtDNA'),
      ]),
    ]),
    m('div.relatives-filter-field', [
      m('span.relatives-filter-label.relatives-filter-label-haplo', 'Y-DNA'),
      m('div.relatives-filter-haplo-row', [
        haploSearchInput('paternal', 'Search Y-DNA', 'Search Y-DNA haplogroups'),
        haploFilterSelect('paternal', 'Any Y-DNA'),
      ]),
    ]),
    m('div.relatives-filter-footer', [
      m('span.relatives-filter-count', { 'aria-live': 'polite' }, active
        ? shown + ' of ' + state.relatives.length
          + (state.relatives.length === 1 ? ' relative' : ' relatives')
        : state.relatives.length + (state.relatives.length === 1 ? ' relative' : ' relatives')),
      m('button.relatives-filter-clear', {
        type: 'button',
        disabled: !active,
        onclick: () => {
          clearFilters();
          m.redraw.sync();
        },
      }, 'Clear'),
    ]),
  ]);
}

/* ---------- View ---------- */

const App = {
  view() {
    const columns = relationshipIndexes(state.relatives);
    const filtered = state.relatives.filter((relative) => passesFilters(relative));
    const rows = sortedRelatives(filtered, state.sort);
    const subtitle = profileName && relativeName
      ? profileName + ' → '
        + (preferences.hideNames ? initialsOfName(relativeName) : relativeName)
      : state.subtitle;

    if (subtitle) {
      document.title = 'Relatives in Common — ' + subtitle;
    }

    return [
      appHeader({
        title: 'Relatives in Common',
        subtitle,
        actions: [
          m('a.btn-flat.waves-effect', {
            href: pageUrl('network.html')
              + '?profile=' + encodeURIComponent(profileId)
              + '&profile_name=' + encodeURIComponent(profileName)
              + '&relative=' + encodeURIComponent(relativeId),
            title: 'View all relatives as a shared DNA network',
          }, 'Shared DNA'),
          m('a.btn-flat.waves-effect', {
            href: pageUrl('index.html'),
          }, 'Back to relatives'),
        ],
      }),

      m('main.container', [
        m('section.card', [
          m('div.card-content', [
          m('div.list-controls', [
            m('p.meta', state.meta),
          ]),

          m('div.compare-filters', filterBar()),

          m('div.table-wrap', m('table.relatives-table.striped.highlight', [
            m('thead', m('tr', [
              m('th', 'Relative'),
              m('th', 'mtDNA'),
              m('th', 'Y-DNA'),
              ...columns.flatMap((index) => [
                m('th', 'Rel ' + index),
                sortableHeader(index),
              ]),
              m('th', 'Sharing'),
            ])),
            m('tbody', rows.length
              ? rows.map((relative) => {
                  const personUrl = profileUrl(profileId, relative.profile_id);
                  const person = [
                    avatar(relative),
                    m('span.relative-name', labelName(relative)),
                  ];
                  const haplogroups = relativeHaplogroups(relative);

                  return m('tr', [
                    m('td', personUrl
                      ? m('a.relative.relative-link', {
                          href: personUrl,
                          target: '_blank',
                          rel: 'noopener noreferrer',
                          title: 'Open this profile on 23andMe',
                        }, person)
                      : m('div.relative', person)),
                    m('td.haplogroup', haplogroups.maternal || '—'),
                    m('td.haplogroup', haplogroups.paternal
                      || (haplogroups.female ? '' : '—')),
                    ...columns.flatMap((index) => [
                      m('td', formatRelationship(relative['predicted_relationship_id_' + index])),
                      m('td', percentageLabel(relative['ibd_proportion_' + index])),
                    ]),
                    m('td', relative.is_open_sharing === undefined || relative.is_open_sharing === null ? '—' : (relative.is_open_sharing ? 'yes' : 'no')),
                  ]);
                })
              : m('tr', m('td.empty', { colspan: 4 + columns.length * 2 },
                  state.loading
                    ? 'Loading…'
                    : state.relatives.length
                      ? 'No relatives match these filters.'
                      : 'No relatives in common'))),
          ])),
          ]),
        ]),

        m('div', { class: state.notice ? 'card-panel notice' : 'card-panel notice hidden' }, state.notice),
      ]),
    ];
  },
};

load();
m.mount(document.getElementById('app'), App);
