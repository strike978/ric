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

function displayValue(value) {
  return value === undefined || value === null || value === '' ? '—' : value;
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
    return [
      m('header.topbar', m('div.brand', [
        m('div.mark', { 'aria-hidden': 'true' }, [m('span'), m('span')]),
        m('div', [
          m('h1', 'Relatives in common'),
          m('p#subtitle.sub', state.subtitle),
        ]),
      ])),

      m('main', [
        m('section.panel', [
          m('p#meta.meta', state.meta),

          m('div.table-wrap', m('table.relatives-table', [
            m('thead', m('tr', [
              m('th', 'Initials'),
              m('th', 'Name'),
              m('th', 'Profile ID'),
              m('th', 'Sharing'),
              m('th', 'Rel 1'),
              m('th', 'IBD 1'),
              m('th', 'Rel 2'),
              m('th', 'IBD 2'),
            ])),
            m('tbody#rows', state.relatives.length
              ? state.relatives.map((relative) => m('tr', [
                  m('td', initialsOf(relative) || '—'),
                  m('td', nameOf(relative) || '—'),
                  m('td.id', displayValue(relative.profile_id)),
                  m('td', relative.is_open_sharing === undefined || relative.is_open_sharing === null ? '—' : (relative.is_open_sharing ? 'yes' : 'no')),
                  m('td', displayValue(relative.predicted_relationship_id_1)),
                  m('td', displayValue(relative.ibd_proportion_1)),
                  m('td', displayValue(relative.predicted_relationship_id_2)),
                  m('td', displayValue(relative.ibd_proportion_2)),
                ]))
              : m('tr', m('td.empty', { colspan: 8 },
                  state.loading ? 'Loading…' : 'No relatives in common'))),
          ])),
        ]),

        m('p#notice', { class: state.notice ? 'notice' : 'notice hidden' }, state.notice),
      ]),
    ];
  },
};

load();
m.mount(document.getElementById('app'), App);
