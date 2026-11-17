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
  comparisons: {},           // relative id -> loading | retrying | ready | error
  comparisonsRunning: false,
  comparisonProgress: null,  // { total, done, remainingMs } while fetching
  clearing: false,
  notice: '',
  noticeLink: '',          // optional URL shown as a link next to the notice
};

// Relatives-in-common page: one pair, read from the database.
export const compareState = {
  subtitle: '',
  meta: '',
  relatives: [],
  loading: false,
  notice: '',
};
