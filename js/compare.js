/*
 * Relatives in common page
 *
 * Shows the comparison for one pair (profile + relative). The main page saves
 * it to IndexedDB, so this page only reads the database.
 */

import { compareState as state } from './state.js';
import { getRelativesInCommon, getSavedRelatives } from './db.js';
import { avatar, displayName, profileUrl } from './person.js';
import { formatRelationship } from './relationships.js';
import { appNav, pageUrl } from './ui.js';

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

/* ---------- Load from IndexedDB ---------- */

async function load() {
  if (profileName && relativeName) {
    state.subtitle = profileName + ' → ' + relativeName;
    document.title = 'Relatives in Common — ' + profileName + ' → ' + relativeName;
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
      state.notice = 'No saved comparison for this pair. Use "Fetch" on the main page first.';
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
      };
    });

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
      appNav({
        title: 'Relatives in Common',
        subtitle: state.subtitle,
        actions: [
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
            m('div.sort-row', m('div.input-field.select-field', [
              m('label.label.active', { for: 'sortSelect' }, 'Sort'),
              m('select#sortSelect.browser-default', {
                value: state.sort,
                onchange: (event) => { state.sort = event.target.value; },
              }, options.map((option) => m('option', {
                value: option.value,
                selected: option.value === state.sort,
              }, option.label))),
            ])),
          ]),

          m('div.table-wrap', m('table.relatives-table.striped.highlight', [
            m('thead', m('tr', [
              m('th', 'Relative'),
              m('th', 'Sharing'),
              ...columns.flatMap((index) => [
                m('th', 'Rel ' + index),
                m('th', 'IBD ' + index),
              ]),
            ])),
            m('tbody', rows.length
              ? rows.map((relative) => {
                  const personUrl = profileUrl(profileId, relative.profile_id);
                  const person = [
                    avatar(relative),
                    m('span.relative-name', displayName(relative)),
                  ];

                  return m('tr', [
                    m('td', personUrl
                      ? m('a.relative.relative-link', {
                          href: personUrl,
                          target: '_blank',
                          rel: 'noopener noreferrer',
                          title: 'Open this profile on 23andMe',
                        }, person)
                      : m('div.relative', person)),
                    m('td', relative.is_open_sharing === undefined || relative.is_open_sharing === null ? '—' : (relative.is_open_sharing ? 'yes' : 'no')),
                    ...columns.flatMap((index) => [
                      m('td', formatRelationship(relative['predicted_relationship_id_' + index])),
                      m('td', percentageLabel(relative['ibd_proportion_' + index])),
                    ]),
                  ]);
                })
              : m('tr', m('td.empty', { colspan: 2 + columns.length * 2 },
                  state.loading ? 'Loading…' : 'No relatives in common'))),
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
