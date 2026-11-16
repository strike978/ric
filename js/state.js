/*
 * App state
 *
 * Plain data only — no DOM and no requests. The page scripts mutate these
 * objects and call m.redraw.sync() when they need the view to update.
 */

// Main page: profiles, the relatives list, and the first-five comparison status.
export const mainState = {
  phase: 'loading',          // loading | ready | error
  profiles: [],
  currentProfileID: null,
  selectedId: '',
  relatives: [],
  relativesPhase: 'idle',    // idle | loading | ready | error
  comparisons: {},           // relative id -> loading | ready | error
  comparisonsRunning: false,
  notice: '',
};

// Relatives-in-common page: one pair, read from the database.
export const compareState = {
  subtitle: '',
  meta: '',
  entries: [],
  loading: false,
  notice: '',
};
