/*
 * App state
 *
 * Plain data only — no DOM and no requests. The page scripts mutate these
 * objects and call m.redraw.sync() when they need the view to update.
 */

// Main page: profiles, the relatives list, and comparison fetch status.
export const mainState = {
  phase: 'loading',          // loading | ready | error
  profiles: [],
  selectedId: '',
  relatives: [],
  relativesPhase: 'idle',    // idle | loading | ready | error
  comparisons: {},           // relative id -> loading | retrying | ready
  comparisonsRunning: false,
  comparisonGapMs: 1500,     // delay between relatives-in-common requests
  retryDelayMs: 60000,       // delay before retrying a failed request
  comparisonProgress: null,  // { total, done, remainingMs } while fetching
  clearing: false,
  transferring: '',           // '' | export | import while a backup is read/written
  notice: '',
  noticeLink: '',          // optional URL shown as a link next to the notice
};

// Relatives-in-common page: one pair, read from the database.
export const compareState = {
  subtitle: '',
  meta: '',
  relatives: [],
  sort: 'saved',            // saved | ibd:N:asc | ibd:N:desc
  loading: false,
  notice: '',
};

// Relatedness matrix page: one selected profile and all of its saved data.
export const matrixState = {
  ownerId: '',
  ownerName: '',
  loading: true,
  loadingText: 'Reading saved relatives…',
  model: null,              // built by relatedness.js
  notice: '',
  query: '',
  metric: 'segments',       // segments | proportion
  minOverlap: '3',          // minimum shared matches for a family group link
  networkOnly: false,       // hide people with no family-group membership
  cluster: 'all',           // all | c1 | c2 ...
  maxPeople: '50',          // 25 | 50 | 100 | 150 | 250 | 500
  selected: null,           // { a, b } ids for the pair-details panel
};
