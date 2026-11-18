/*
 * Main page
 *
 * 1. GET you.23andme.com and read the signed-in profiles from the inline
 *    quickInviteModal data (see profiles.js).
 * 2. Load the selected profile's DNA relatives as soon as a profile is picked;
 *    a spinner shows while they load.
 * 3. Fetch relatives-in-common for every loaded relative, one at a time, with a
 *    one second gap. Only the active row shows a spinner; then it gets an Open
 *    button. If a fetch fails, the same relative is retried every minute
 *    instead of moving on to the next one, and a Chrome notification appears.
 * 4. Save all of each pair's relatives in common to IndexedDB so compare.html
 *    can render them.
 */

import { mainState as state } from './state.js';
import { extractProfiles } from './profiles.js';
import {
  saveRelatives,
  saveRelativesInCommon,
  getProfileRelativesInCommon,
  deleteDatabase,
  replaceDatabaseFromRecords,
} from './db.js';
import { exportDatabaseFile, readDatabaseBackup } from './sqlite.js';

const TARGET_URL = 'https://you.23andme.com/';

const RETRY_DELAY_MS = 60000;

let relativesXhr = null;
let comparisonXhr = null;
let relativesSeq = 0;
let comparisonsSeq = 0;

/* ---------- Response shapes ---------- */

function pickRelatives(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload && Array.isArray(payload.relatives) ? payload.relatives : [];

  // Keep every field the endpoint returns.
  return list.filter((relative) => relative && typeof relative === 'object');
}

// Returns true for one relatives-in-common record.
function isCommonRelative(item) {
  return item && typeof item === 'object'
    && ('profile_id' in item || 'predicted_relationship_id_1' in item);
}

// Accepts an array, a single relative, or an object that wraps the array.
function extractCommonRelatives(payload) {
  if (Array.isArray(payload)) return payload.filter(isCommonRelative);

  if (payload && typeof payload === 'object') {
    if (isCommonRelative(payload)) return [payload];

    for (const value of Object.values(payload)) {
      if (Array.isArray(value)) {
        const relatives = value.filter(isCommonRelative);
        if (relatives.length > 0) return relatives;
      }
    }
  }

  return [];
}

/* ---------- Endpoints and requests ---------- */

function relativesUrl(profileId) {
  return 'https://you.23andme.com/p/' + encodeURIComponent(profileId)
    + '/family/relatives/ajax/';
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

// True when the request ended up on a 23andMe sign-in page, i.e. the browser
// session is not signed in (or the request did not carry the session cookie).
function isLoginUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'auth.23andme.com'
      || /(^|\/)login(\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

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
    const finalUrl = res.url || TARGET_URL;

    // Useful when the extension seems to think you are signed out: this shows
    // whether 23andMe redirected to the login page and with what status.
    console.debug('23andMe profile request', {
      status: res.status,
      ok: res.ok,
      redirected: res.redirected,
      finalUrl,
    });

    if (isLoginUrl(finalUrl)) {
      state.phase = 'error';
      state.notice = 'Sign in to 23andMe and reload.';
      state.noticeLink = TARGET_URL;
      return;
    }

    if (!res.ok) {
      state.phase = 'error';
      state.notice = '23andMe returned an error (HTTP ' + res.status
        + '). Open 23andMe, make sure you are signed in, then reload.';
      state.noticeLink = TARGET_URL;
      return;
    }

    const result = extractProfiles(html);

    if (!result.data || result.data.profiles.length === 0) {
      if (result.error) console.warn('Could not read profiles:', result.error);
      state.phase = 'error';
      state.notice = '23andMe did not return your profiles. Open 23andMe, '
        + 'make sure you are signed in, then reload.';
      state.noticeLink = TARGET_URL;
      return;
    }

    state.noticeLink = '';
    state.profiles = result.data.profiles;
    state.selectedId = '';
    state.phase = 'ready';
  } catch (err) {
    console.warn('Could not load profiles:', err);
    state.phase = 'error';
    state.notice = 'Could not reach 23andMe. Check your connection, then reload.';
    state.noticeLink = TARGET_URL;
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
  cancelComparisons();
  state.comparisons = {};
  state.notice = '';
  state.noticeLink = '';

  try {
    const xhr = await xhrGet(url, (request) => { relativesXhr = request; });
    if (seq !== relativesSeq) return;

    const finalUrl = xhr.responseURL || url;
    console.debug('23andMe relatives request', {
      status: xhr.status,
      finalUrl,
    });

    if (isLoginUrl(finalUrl)) {
      state.relativesPhase = 'error';
      state.notice = 'Sign in to 23andMe and reload.';
      state.noticeLink = TARGET_URL;
      return;
    }

    if (xhr.status < 200 || xhr.status >= 300) {
      state.relativesPhase = 'error';
      state.notice = '23andMe returned an error (HTTP ' + xhr.status
        + ') while loading relatives. Open 23andMe, make sure you are signed in, then reload.';
      state.noticeLink = TARGET_URL;
      return;
    }

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

    await restoreSavedComparisons(profileId, seq);
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

/* ---------- Failure notifications ---------- */

const RETRY_NOTIFICATION_PREFIX = 'ric-retry-';
const retryNotifications = new Set();

// Shows (or updates) one notification per failing relative, so a relative that
// keeps failing after each retry doesn't stack up notifications.
function notifyRetry(relativeId, relative, err) {
  if (!chrome.notifications || !chrome.notifications.create) return;

  const notificationId = RETRY_NOTIFICATION_PREFIX + relativeId;
  retryNotifications.add(notificationId);

  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Relatives in Common',
    message: 'Could not get relatives in common for '
      + (relative.initials || relativeId) + ' ('
      + (err && err.message ? err.message : String(err))
      + '). Retrying in 1 minute.',
    priority: 2,
    requireInteraction: true,
  }, () => void chrome.runtime.lastError);
}

function clearRetryNotification(relativeId) {
  if (!chrome.notifications || !chrome.notifications.clear) return;
  clearNotificationById(RETRY_NOTIFICATION_PREFIX + relativeId);
}

function clearAllRetryNotifications() {
  for (const notificationId of [...retryNotifications]) {
    clearNotificationById(notificationId);
  }
}

function clearNotificationById(notificationId) {
  retryNotifications.delete(notificationId);
  chrome.notifications.clear(notificationId, () => void chrome.runtime.lastError);
}

function formatRemaining(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return seconds + 's';

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes + 'm' + (rest ? ' ' + rest + 's' : '');
}

// Marks rows whose relatives-in-common data is already saved for this profile.
async function restoreSavedComparisons(profileId, seq) {
  try {
    const pairs = await getProfileRelativesInCommon(profileId);
    if (seq !== relativesSeq) return;

    state.comparisons = {};
    for (const pair of pairs) {
      if (pair && pair.relative_profile_id) {
        state.comparisons[pair.relative_profile_id] = 'ready';
      }
    }
  } catch (err) {
    console.warn('Could not read saved relatives in common', err);
  }
}

// Stops an in-flight comparison loop and clears its progress.
function cancelComparisons() {
  comparisonsSeq++;
  state.comparisonsRunning = false;
  state.comparisonProgress = null;
  clearAllRetryNotifications();

  if (comparisonXhr) {
    comparisonXhr.abort();
    comparisonXhr = null;
  }

  // Clear rows that were mid-flight so they don't keep spinning.
  for (const relativeId of Object.keys(state.comparisons)) {
    const status = state.comparisons[relativeId];
    if (status === 'loading' || status === 'retrying') delete state.comparisons[relativeId];
  }
}

// Stops the running comparison loop from the Stop button.
function stopComparisons() {
  if (!state.comparisonsRunning) return;

  cancelComparisons();
  state.notice = '';
  m.redraw.sync();
}

// Fetches comparisons that are not already saved for every loaded relative,
// sequentially, 1s apart. A failed fetch does not skip ahead: the same
// relative is retried after 1 minute until it succeeds or the run is stopped. The
// row being fetched shows a spinner; finished rows get an Open button.
async function getRelativesInCommon() {
  if (!state.selectedId || state.relatives.length === 0 || state.comparisonsRunning) return;

  const profileId = state.selectedId;
  const targets = state.relatives.filter((relative) => relative.relative_profile_id
    && state.comparisons[relative.relative_profile_id] !== 'ready');
  const total = targets.length;

  if (total === 0) return;

  const seq = ++comparisonsSeq;
  const startedAt = Date.now();

  state.comparisonsRunning = true;
  state.notice = '';
  state.comparisonProgress = {
    total,
    done: 0,
    remainingMs: total * state.comparisonGapMs,
  };
  m.redraw.sync();

  for (let index = 0; index < total; index++) {
    if (seq !== comparisonsSeq) return;

    const relative = targets[index];
    const relativeId = relative.relative_profile_id;
    const elapsed = Date.now() - startedAt;
    const average = index > 0 ? elapsed / index : state.comparisonGapMs;

    state.comparisonProgress = {
      total,
      done: index,
      remainingMs: (total - index) * average,
    };
    m.redraw.sync();

    // Retry this same relative until it succeeds; never move on after a
    // failure.
    for (;;) {
      if (seq !== comparisonsSeq) return;

      state.comparisons[relativeId] = 'loading';
      state.notice = '';
      m.redraw.sync();

      try {
        const xhr = await xhrGet(
          comparisonUrl(profileId, relativeId),
          (request) => { comparisonXhr = request; },
        );
        comparisonXhr = null;
        if (seq !== comparisonsSeq) return;

        if (xhr.status < 200 || xhr.status >= 300) {
          throw new Error('HTTP ' + xhr.status);
        }

        let payload;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          throw new Error('response was not JSON');
        }

        const relativesInCommon = extractCommonRelatives(payload);

        await saveRelativesInCommon(profileId, relativeId, relativesInCommon);
        if (seq !== comparisonsSeq) return;
        clearRetryNotification(relativeId);
        break;
      } catch (err) {
        if (seq !== comparisonsSeq) return;

        state.comparisons[relativeId] = 'retrying';
        state.notice = 'Could not get relatives in common for '
          + (relative.initials || relativeId) + ' ('
          + (err && err.message ? err.message : String(err))
          + '). Retrying in 1 minute…';
        notifyRetry(relativeId, relative, err);
        m.redraw.sync();

        await sleep(RETRY_DELAY_MS);
        if (seq !== comparisonsSeq) return;
      }
    }

    state.comparisons[relativeId] = 'ready';
    state.comparisonProgress = {
      total,
      done: index + 1,
      remainingMs: (total - index - 1) * average,
    };
    m.redraw.sync();

    if (index < total - 1) {
      await sleep(state.comparisonGapMs);
      if (seq !== comparisonsSeq) return;
    }
  }

  state.comparisonsRunning = false;
  state.comparisonProgress = null;
  m.redraw.sync();
}

// Opens compare.html for one relative. The page reads the saved result.
function openComparison(relativeId) {
  if (!state.selectedId || !relativeId) return;

  const url = chrome.runtime.getURL('compare.html')
    + '?profile=' + encodeURIComponent(state.selectedId)
    + '&relative=' + encodeURIComponent(relativeId);

  if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
}

// Deletes the whole local database after confirmation.
async function deleteData() {
  if (state.clearing || state.transferring || state.relativesPhase === 'loading' || state.comparisonsRunning) return;

  const confirmed = window.confirm(
    'Delete the entire local database and all saved relatives and relatives-in-common data from this browser?'
  );
  if (!confirmed) return;

  cancelComparisons();
  state.clearing = true;
  state.notice = '';
  m.redraw.sync();

  try {
    await deleteDatabase();
    state.relatives = [];
    state.relativesPhase = 'idle';
    state.comparisons = {};
    state.notice = 'Local database deleted.';
  } catch (err) {
    state.notice = 'Could not delete the local database: ' + (err.message || err);
  } finally {
    state.clearing = false;
    m.redraw.sync();
  }
}

/* ---------- Export / import ---------- */

function exportFilename() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return 'relatives-in-common-'
    + now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
    + '.db';
}

// Saves the SQLite file, using a save dialog when the browser offers one and
// falling back to a regular download.
async function saveExport(bytes) {
  let handle = null;

  if (typeof window.showSaveFilePicker === 'function') {
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: exportFilename(),
        types: [{
          description: 'SQLite database',
          accept: { 'application/vnd.sqlite3': ['.db', '.sqlite'] },
        }],
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return false;

      // The save dialog is not always usable from an extension page; fall back
      // to a regular download instead of failing the export.
      if (!err || (err.name !== 'NotAllowedError' && err.name !== 'SecurityError')) {
        throw err;
      }
    }
  }

  if (handle) {
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (err) {
      try { await writable.abort(); } catch { /* ignore */ }
      throw err;
    }
    return true;
  }

  const blob = new Blob([bytes], { type: 'application/vnd.sqlite3' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = exportFilename();
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

// Writes the whole database to a SQLite file the user can keep, query, or move
// to another browser.
async function exportData() {
  if (state.transferring) return;

  state.transferring = 'export';
  state.notice = '';
  m.redraw.sync();

  const counts = { profiles: 0, comparisons: 0 };

  try {
    const bytes = await exportDatabaseFile(counts);
    const saved = await saveExport(bytes);
    if (saved) {
      state.notice = 'Exported ' + counts.profiles + ' profile(s) and '
        + counts.comparisons + ' comparison(s).';
    }
  } catch (err) {
    state.notice = 'Could not export the database: ' + (err.message || err);
  } finally {
    state.transferring = '';
    m.redraw.sync();
  }
}

function chooseImportFile() {
  if (state.transferring || state.clearing || state.comparisonsRunning) return;

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.db,.sqlite,.sqlite3,application/vnd.sqlite3,application/x-sqlite3';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (file) importData(file);
  };
  input.click();
}

// Reads a previously exported SQLite file back into the database, replacing
// everything that is currently saved.
async function importData(file) {
  const confirmed = window.confirm(
    'Import "' + file.name + '"?\n\n'
    + 'This replaces the whole local database: all saved relatives and relatives-in-common data '
    + 'will be deleted and replaced by the file\'s contents.'
  );
  if (!confirmed) return;

  state.transferring = 'import';
  state.notice = '';
  m.redraw.sync();

  let backup = null;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    backup = await readDatabaseBackup(bytes);

    await replaceDatabaseFromRecords(backup.records());

    // Reload the selected profile's saved markers so imported comparisons show
    // up as Open right away.
    if (state.selectedId) {
      await restoreSavedComparisons(state.selectedId, relativesSeq);
    }

    state.notice = 'Imported ' + backup.profiles + ' profile(s) and '
      + backup.comparisons + ' comparison(s).';
  } catch (err) {
    state.notice = 'Could not import the file: ' + (err.message || err);
  } finally {
    if (backup) backup.close();
    state.transferring = '';
    m.redraw.sync();
  }
}

/* ---------- View ---------- */

function actionFor(relative) {
  const relativeId = relative.relative_profile_id;
  const status = state.comparisons[relativeId];

  if (status === 'loading') return m('span.spinner', { title: 'Loading' });
  if (status === 'retrying') return m('span.action-retry', { title: 'Failed; retrying in 1 minute' }, 'Retrying…');
  if (status === 'ready') {
    return m('button.link-button', {
      type: 'button',
      onclick: () => openComparison(relativeId),
    }, 'Open');
  }
  return null;
}

const App = {
  view() {
    const placeholder = state.phase === 'loading'
      ? 'Loading…'
      : state.phase === 'error' ? 'No profiles found' : 'Choose a profile…';

    const progress = state.comparisonProgress;
    const progressPercent = progress
      ? Math.round((progress.done / progress.total) * 100)
      : 0;
    const progressText = progress
      ? progress.done + ' of ' + progress.total
        + (progress.done < progress.total
          ? ' · about ' + formatRemaining(progress.remainingMs) + ' left'
          : ' · finishing…')
      : '';

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
              state.selectedId = event.target.value;
              state.relatives = [];
              state.relativesPhase = 'idle';
              cancelComparisons();
              state.comparisons = {};
              state.notice = '';

              // Picking a profile loads its relatives right away.
              loadRelatives();
            },
          }, [
            m('option', { value: '', selected: state.selectedId === '' }, placeholder),
            ...state.profiles.map((profile) => m('option', {
              value: profile.id,
              selected: profile.id === state.selectedId,
            }, [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.id)),
          ]),

          m('div', { class: state.selectedId ? 'id-box' : 'id-box hidden' }, [
            m('span.id-label', 'ID'),
            m('code.id-value', state.selectedId),
          ]),

          m('div.button-row', [
            m('button.secondary', {
              type: 'button',
              disabled: state.relatives.length === 0,
              onclick: state.comparisonsRunning ? stopComparisons : getRelativesInCommon,
            }, state.comparisonsRunning ? 'Stop' : 'Get relatives in common'),
            m('label.label', { for: 'requestDelay' }, 'Delay (seconds)'),
            m('input#requestDelay', {
              type: 'number',
              min: '0',
              step: 'any',
              value: String(state.comparisonGapMs / 1000),
              title: 'Delay between relatives-in-common requests, in seconds',
              onchange: (event) => {
                const raw = event.target.value.trim();
                const seconds = Number(raw);

                if (raw !== '' && Number.isFinite(seconds) && seconds >= 0) {
                  state.comparisonGapMs = Math.round(seconds * 1000);
                }

                event.target.value = String(state.comparisonGapMs / 1000);
              },
            }),
          ]),

          m('div.progress', { class: progress ? 'progress' : 'progress hidden' }, [
            m('div.progress-track', {
              role: 'progressbar',
              'aria-valuemin': 0,
              'aria-valuemax': progress ? progress.total : 0,
              'aria-valuenow': progress ? progress.done : 0,
            }, m('div.progress-fill', { style: { width: progressPercent + '%' } })),
            m('p.progress-label', { 'aria-live': 'polite' }, progressText),
          ]),

          m('div', {
            class: state.relativesPhase === 'loading'
              || state.relativesPhase === 'error'
              || state.relatives.length
              ? 'output' : 'output hidden',
          }, [
            m('div.table-wrap', m('table.relatives-table', [
              m('thead', m('tr', [
                m('th.num-col', '#'),
                m('th', 'Initials'),
                m('th', 'Relative profile ID'),
                m('th.actions-col', 'Relatives in common'),
              ])),
              m('tbody', state.relativesPhase === 'loading'
                ? m('tr', m('td.empty', { colspan: 4 }, [
                    m('span.spinner'),
                    ' Loading relatives…',
                  ]))
                : state.relatives.length
                  ? state.relatives.map((relative, index) => m('tr', { key: relative.relative_profile_id || index }, [
                      m('td.num', index + 1),
                      m('td', relative.initials || ''),
                      m('td.id', relative.relative_profile_id || ''),
                      m('td.actions', actionFor(relative)),
                    ]))
                  : m('tr', m('td.empty', { colspan: 4 },
                      state.relativesPhase === 'error' ? 'Request failed' : 'No relatives'))),
            ])),
          ]),

          m('div.panel-footer', [
            m('span.footnote', 'Saved data stays in this browser. Export it to back it up or move it.'),
            m('div.footer-actions', [
              m('button.link-button', {
                type: 'button',
                title: 'Download the saved database as a SQLite .db file',
                disabled: state.transferring || state.clearing
                  || state.relativesPhase === 'loading' || state.comparisonsRunning,
                onclick: exportData,
              }, state.transferring === 'export' ? 'Exporting…' : 'Export'),
              m('button.link-button', {
                type: 'button',
                title: 'Load a previously exported SQLite .db file',
                disabled: state.transferring || state.clearing
                  || state.relativesPhase === 'loading' || state.comparisonsRunning,
                onclick: chooseImportFile,
              }, state.transferring === 'import' ? 'Importing…' : 'Import'),
              m('button.link-button.danger', {
                type: 'button',
                disabled: state.clearing || state.transferring
                  || state.relativesPhase === 'loading' || state.comparisonsRunning,
                onclick: deleteData,
              }, state.clearing ? 'Deleting…' : 'Delete database'),
            ]),
          ]),
        ]),

        m('p', { class: state.notice ? 'notice' : 'notice hidden' }, [
          state.notice,
          state.noticeLink
            ? m('a.notice-link', {
                href: state.noticeLink,
                target: '_blank',
                rel: 'noopener noreferrer',
              }, 'Open 23andMe')
            : null,
        ]),
      ]),
    ];
  },
};

m.mount(document.getElementById('app'), App);
loadProfiles();
