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
  filters: {                 // table filter, applied to the loaded relatives
    name: '',                // full name or last name search text
    maternal: '',            // mtDNA haplogroup search text
    paternal: '',            // Y-DNA haplogroup search text
  },
  comparisons: {},           // relative id -> loading | retrying | ready
  comparisonsRunning: false,
  comparisonGapMs: 2000,     // delay between relatives-in-common requests
  haplogroupGapMs: 1000,     // delay between relative haplogroup requests
  retryDelayMs: 60000,       // delay before retrying a failed request
  comparisonProgress: null,  // { total, done, remainingMs } while fetching
  clearing: false,
  clearingProfile: false,      // true while one profile's saved data is deleted
  transferring: '',           // '' | export | import while a transfer is read/written
  notice: '',
  noticeLink: '',          // optional URL shown as a link next to the notice
};

// Relatives-in-common page: one pair, read from the database.
export const compareState = {
  subtitle: '',
  meta: '',
  relatives: [],
  sort: 'ibd:1:desc',       // ibd:N:asc | ibd:N:desc (saved only as fallback)
  loading: false,
  notice: '',
};

// Shared DNA network page: one profile's relatives as a force-directed graph.
export const networkState = {
  loading: true,
  notice: '',
  profileId: '',
  profileName: '',
  owner: null,
  nodes: [],               // owner + relatives, with x/y/radius/adjacency
  edges: [],               // owner-relative and relative-relative connections
  adjacency: new Map(),    // node id -> [{ node, edge }]
  stats: {
    relatives: 0,
    totalRelatives: 0,
    matches: 0,
    connections: 0,
    shared: 0,
    confirmed: 0,
    oneSided: 0,
  },
  selectedId: '',          // node id, or '' for the overview
  labels: true,            // draw names next to nodes
  includeSharedMatches: true, // shared matches seen under 2+ relatives
  filters: {               // graph filter, applied when the graph is rebuilt
    name: '',
    minCM: '',
    maxCM: '',
    maternal: '',
    paternal: '',
  },
};

