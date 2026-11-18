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
  comparisonGapMs: 1000,     // delay between relatives-in-common requests
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
