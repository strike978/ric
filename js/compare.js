/*
 * Relatives in common page
 *
 * Shows the comparison for one pair (profile + relative). The main page saves
 * it to IndexedDB, so this page only reads the database.
 */

import { compareState as state } from './state.js';
import { getRelativesInCommon } from './db.js';

const params = new URLSearchParams(location.search);
const profileId = params.get('profile') || '';
const relativeId = params.get('relative') || '';

/* ---------- Helpers for one comparison entry ---------- */

function initialsOf(relative) {
  return [relative.first_initial, relative.last_initial].filter(Boolean).join('');
}

function nameOf(relative) {
  return [relative.first_name, relative.last_name].filter(Boolean).join(' ');
}

function displayName(relative) {
  return nameOf(relative) || initialsOf(relative) || relative.initials || '—';
}

function displayValue(value) {
  return value === undefined || value === null || value === '' ? '—' : value;
}

function relativeProfileUrl(relativeId) {
  if (!profileId || !relativeId) return null;

  return 'https://you.23andme.com/p/' + encodeURIComponent(profileId)
    + '/profile/' + encodeURIComponent(relativeId) + '/';
}

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

function sortOptions(indexes) {
  const options = [{ value: 'saved', label: 'Saved order' }];

  for (const index of indexes) {
    options.push(
      { value: 'ibd:' + index + ':desc', label: 'IBD ' + index + ' (high to low)' },
      { value: 'ibd:' + index + ':asc', label: 'IBD ' + index + ' (low to high)' },
    );
  }

  return options;
}

function numberValue(value) {
  if (value === undefined || value === null || value === '') return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

/* ---------- Load from IndexedDB ---------- */

async function load() {
  state.subtitle = profileId && relativeId ? profileId + ' → ' + relativeId : '';

  if (!profileId || !relativeId) {
    state.notice = 'Missing profile or relative id.';
    return;
  }

  state.loading = true;
  state.meta = 'Loading…';

  try {
    const relatives = await getRelativesInCommon(profileId, relativeId);
    if (!relatives) {
      state.meta = '';
      state.notice = 'No saved comparison for this pair. Use "Get relatives in common" on the main page first.';
      return;
    }

    state.relatives = relatives;
    state.meta = relatives.length + ' relative' + (relatives.length === 1 ? '' : 's') + ' in common';
  } catch {
    state.meta = '';
    state.notice = 'Could not read the local database.';
  } finally {
    state.loading = false;
    m.redraw.sync();
  }
}

/* ---------- View ---------- */

const App = {
  view() {
    const columns = relationshipIndexes(state.relatives);
    const rows = sortedRelatives(state.relatives, state.sort);
    const options = sortOptions(columns);

    return [
      m('header.topbar', m('div.brand', [
        m('div.mark', { 'aria-hidden': 'true' }, [m('span'), m('span')]),
        m('div', [
          m('h1', 'Relatives in Common'),
          m('p.sub', state.subtitle),
        ]),
      ])),

      m('main', [
        m('section.panel', [
          m('div.list-controls', [
            m('p.meta', state.meta),
            m('div.sort-row', [
              m('label.label', { for: 'sortSelect' }, 'Sort'),
              m('select#sortSelect', {
                value: state.sort,
                onchange: (event) => { state.sort = event.target.value; },
              }, options.map((option) => m('option', {
                value: option.value,
                selected: option.value === state.sort,
              }, option.label))),
            ]),
          ]),

          m('div.table-wrap', m('table.relatives-table', [
            m('thead', m('tr', [
              m('th', { title: 'Name, or initials when no name is shown' }, 'Name'),
              m('th', 'Profile ID'),
              m('th', 'Sharing'),
              ...columns.flatMap((index) => [
                m('th', 'Rel ' + index),
                m('th', 'IBD ' + index),
              ]),
            ])),
            m('tbody', rows.length
              ? rows.map((relative) => {
                  const profileUrl = relativeProfileUrl(relative.profile_id);

                  return m('tr', [
                    m('td', displayName(relative)),
                    m('td.id', profileUrl
                      ? m('a', {
                          href: profileUrl,
                          target: '_blank',
                          rel: 'noopener noreferrer',
                          title: 'Open this profile on 23andMe',
                        }, displayValue(relative.profile_id))
                      : displayValue(relative.profile_id)),
                    m('td', relative.is_open_sharing === undefined || relative.is_open_sharing === null ? '—' : (relative.is_open_sharing ? 'yes' : 'no')),
                    ...columns.flatMap((index) => [
                      m('td', displayValue(relative['predicted_relationship_id_' + index])),
                      m('td', displayValue(relative['ibd_proportion_' + index])),
                    ]),
                  ]);
                })
              : m('tr', m('td.empty', { colspan: 3 + columns.length * 2 },
                  state.loading ? 'Loading…' : 'No relatives in common'))),
          ])),
        ]),

        m('p', { class: state.notice ? 'notice' : 'notice hidden' }, state.notice),
      ]),
    ];
  },
};

load();
m.mount(document.getElementById('app'), App);
