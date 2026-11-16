/*
 * Main page
 *
 * 1. GET you.23andme.com and read the signed-in profiles from the inline
 *    quickInviteModal data (see profiles.js).
 * 2. Load the selected profile's DNA relatives.
 * 3. Fetch relatives-in-common for the first two rows, one at a time, with a
 *    one second gap. Only the active row shows a spinner; then it gets an Open
 *    button.
 * 4. Save each comparison (its first two entries) to IndexedDB so compare.html
 *    can render it.
 */

import { mainState as state } from './state.js';
import { extractProfiles } from './profiles.js';
import { saveRelatives, saveComparison } from './db.js';

const TARGET_URL = 'https://you.23andme.com/';
const COMPARISON_LIMIT = 2;
const COMPARISON_ENTRY_LIMIT = 2;

let relativesXhr = null;
let relativesSeq = 0;

/* ---------- Response shapes ---------- */

function pickRelatives(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload && Array.isArray(payload.relatives) ? payload.relatives : [];

  // Keep every field the endpoint returns.
  return list.filter((relative) => relative && typeof relative === 'object');
}

function looksLikeEntry(item) {
  return item && typeof item === 'object'
    && ('profile_id' in item || 'predicted_relationship_id_1' in item);
}

// Accepts an array, a single entry, or an object that wraps the array.
function extractEntries(payload) {
  if (Array.isArray(payload)) return payload.filter(looksLikeEntry);

  if (payload && typeof payload === 'object') {
    if (looksLikeEntry(payload)) return [payload];

    for (const value of Object.values(payload)) {
      if (Array.isArray(value)) {
        const entries = value.filter(looksLikeEntry);
        if (entries.length > 0) return entries;
      }
    }
  }

  return [];
}

/* ---------- Endpoints and requests ---------- */

function relativesUrl(profileId) {
  return 'https://you.23andme.com/p/' + encodeURIComponent(profileId)
    + '/family/relatives/ajax/?limit=2';
}

function comparisonUrl(profileId, relativeId) {
  return 'https://you.23andme.com/p/' + encodeURIComponent(profileId)
    + '/profile/' + encodeURIComponent(relativeId) + '/relatives_in_common/';
}

// The AJAX routes expect X-Requested-With; without it 23andMe returns HTML.
function xhrGet(url, register) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.setRequestHeader('Accept', 'application/json, text/javascript, */*; q=0.01');
    xhr.onload = () => resolve(xhr);
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (register) register(xhr);
    xhr.send();
  });
}

/* ---------- Loading profiles and relatives ---------- */

// Reads the profiles from the home page response.
async function loadProfiles() {
  try {
    const res = await fetch(TARGET_URL, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    });

    const html = await res.text();
    const result = extractProfiles(html);

    if (!result.data || result.data.profiles.length === 0) {
      state.phase = 'error';
      state.notice = 'Sign in at https://you.23andme.com/ and reload.';
      return;
    }

    state.profiles = result.data.profiles;
    state.currentProfileID = result.data.currentProfileID;
    const current = state.profiles.find((profile) => profile.id === state.currentProfileID);
    state.selectedId = current ? current.id : '';
    state.phase = 'ready';
  } catch (err) {
    state.phase = 'error';
    state.notice = err && err.message ? err.message : String(err);
  } finally {
    m.redraw.sync();
  }
}

// Loads the DNA relatives list for the selected profile and saves it locally.
async function loadRelatives() {
  if (!state.selectedId) return;

  const profileId = state.selectedId;
  const seq = ++relativesSeq;
  if (relativesXhr) relativesXhr.abort();

  const url = relativesUrl(profileId);

  state.relativesPhase = 'loading';
  state.relatives = [];
  state.comparisons = {};
  state.comparisonsRunning = false;
  state.notice = '';

  try {
    const xhr = await xhrGet(url, (request) => { relativesXhr = request; });
    if (seq !== relativesSeq) return;

    let relatives;
    try {
      relatives = pickRelatives(JSON.parse(xhr.responseText));
    } catch {
      state.relativesPhase = 'error';
      state.notice = 'Relatives response was not JSON.';
      return;
    }

    if (seq !== relativesSeq) return;

    state.relatives = relatives;
    state.relativesPhase = 'ready';

    try {
      await saveRelatives(profileId, relatives);
    } catch (err) {
      console.warn('Could not save relatives to IndexedDB', err);
      state.notice = 'Relatives loaded, but could not be saved to the local database.';
    }
  } catch (err) {
    if (seq !== relativesSeq || (err && err.name === 'AbortError')) return;
    state.relativesPhase = 'error';
    state.notice = 'Request failed: ' + (err.message || err);
  } finally {
    if (seq === relativesSeq) {
      relativesXhr = null;
      m.redraw.sync();
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetches the first COMPARISON_LIMIT comparisons sequentially, 1s apart. The
// row being fetched shows a spinner; finished rows get an Open button.
async function getRelativesInCommon() {
  if (!state.selectedId || state.relatives.length === 0 || state.comparisonsRunning) return;

  const profileId = state.selectedId;
  const targets = state.relatives.slice(0, COMPARISON_LIMIT);

  state.comparisons = {};
  state.comparisonsRunning = true;
  state.notice = '';
  m.redraw.sync();

  for (let index = 0; index < targets.length; index++) {
    const relativeId = targets[index].relative_profile_id;

    if (relativeId) {
      state.comparisons[relativeId] = 'loading';
      m.redraw.sync();

      try {
        const xhr = await xhrGet(comparisonUrl(profileId, relativeId));
        const entries = extractEntries(JSON.parse(xhr.responseText))
          .slice(0, COMPARISON_ENTRY_LIMIT);

        await saveComparison(profileId, relativeId, entries);
        state.comparisons[relativeId] = 'ready';
      } catch {
        state.comparisons[relativeId] = 'error';
      }

      m.redraw.sync();
    }

    if (index < targets.length - 1) await sleep(1000);
  }

  state.comparisonsRunning = false;
  m.redraw.sync();
}

// Opens compare.html for one relative. The page reads the cached result.
function openComparison(relativeId) {
  if (!state.selectedId || !relativeId) return;

  const url = chrome.runtime.getURL('compare.html')
    + '?profile=' + encodeURIComponent(state.selectedId)
    + '&relative=' + encodeURIComponent(relativeId);

  if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
}

/* ---------- View ---------- */

function actionFor(relative, index) {
  if (index >= COMPARISON_LIMIT) return null;

  const relativeId = relative.relative_profile_id;
  const status = state.comparisons[relativeId];

  if (status === 'loading') return m('span.spinner', { title: 'Loading' });
  if (status === 'ready') {
    return m('button.link-button', {
      type: 'button',
      onclick: () => openComparison(relativeId),
    }, 'Open');
  }
  if (status === 'error') return m('span.action-error', 'Failed');
  return null;
}

const App = {
  view() {
    const placeholder = state.phase === 'loading'
      ? 'Loading…'
      : state.phase === 'error' ? 'No profiles found' : 'Choose a profile…';

    return [
      m('header.topbar', m('div.brand', [
        m('div.mark', { 'aria-hidden': 'true' }, [m('span'), m('span')]),
        m('h1', 'Relatives in Common'),
      ])),

      m('main', [
        m('section.panel', [
          m('label.label', { for: 'profileSelect' }, 'Profile'),

          m('select#profileSelect', {
            disabled: state.phase !== 'ready',
            value: state.selectedId,
            onchange: (event) => {
              relativesSeq++;
              if (relativesXhr) {
                relativesXhr.abort();
                relativesXhr = null;
              }
              state.selectedId = event.target.value;
              state.relatives = [];
              state.relativesPhase = 'idle';
              state.comparisons = {};
              state.comparisonsRunning = false;
              state.notice = '';
            },
          }, [
            m('option', { value: '', selected: state.selectedId === '' }, placeholder),
            ...state.profiles.map((profile) => m('option', {
              value: profile.id,
              selected: profile.id === state.selectedId,
            }, [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.id)),
          ]),

          m('div#idBox', { class: state.selectedId ? 'id-box' : 'id-box hidden' }, [
            m('span.id-label', 'ID'),
            m('code#profileId.id-value', state.selectedId),
          ]),

          m('div.button-row', [
            m('button#loadRelatives.primary', {
              type: 'button',
              disabled: !state.selectedId || state.relativesPhase === 'loading',
              onclick: loadRelatives,
            }, state.relativesPhase === 'loading' ? 'Loading…' : 'Load relatives'),

            m('button#getRelatives.secondary', {
              type: 'button',
              disabled: state.relatives.length === 0 || state.comparisonsRunning,
              onclick: getRelativesInCommon,
            }, state.comparisonsRunning ? 'Getting…' : 'Get relatives in common'),
          ]),

          m('div#relativesOutput', { class: state.relatives.length ? 'output' : 'output hidden' }, [
            m('div.table-wrap', m('table.relatives-table', [
              m('thead', m('tr', [
                m('th', 'Initials'),
                m('th', 'Relative profile ID'),
                m('th.actions-col', 'Relatives in common'),
              ])),
              m('tbody#relativesBody', state.relatives.length
                ? state.relatives.map((relative, index) => m('tr', { key: relative.relative_profile_id || index }, [
                    m('td', relative.initials || ''),
                    m('td.id', relative.relative_profile_id || ''),
                    m('td.actions', actionFor(relative, index)),
                  ]))
                : m('tr', m('td.empty', { colspan: 3 },
                    state.relativesPhase === 'error' ? 'Request failed' : 'No relatives'))),
            ])),
          ]),
        ]),

        m('p#notice', { class: state.notice ? 'notice' : 'notice hidden' }, state.notice),
      ]),
    ];
  },
};

m.mount(document.getElementById('app'), App);
loadProfiles();
