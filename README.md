# Relatives in Common

A proof-of-concept Chromium extension for getting 23andMe **relatives in common** for
a 23andMe profile.

It uses the 23andMe session already open in your browser. There is no separate login
and no password is stored. Pick a profile, load its DNA relatives, and ask for each
one's relatives-in-common list.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Click the **Relatives in Common** icon in the toolbar.

## How to use

1. Make sure you are signed in at <https://you.23andme.com> in this browser.
2. Click the extension icon.
3. Pick a profile from the menu. That profile's DNA relatives load right away
   with a spinner in the table. Each row shows the relative's avatar and name,
   the estimated shared cM and number of segments, their mtDNA and Y-DNA
   haplogroups (once fetched), their sharing status, and the relatives-in-common
   action. Click the avatar or name to open the relative's profile on 23andMe. If you have loaded this
   profile before, any newly added relatives are fetched automatically and
   added to the saved comparisons of the people they match.

   Above the table, the **Full name or last name** search and the **mtDNA** /
   **Y-DNA** searches filter which relatives are shown; **Clear** resets all
   three. Name searches match from the start of the full name or last name; a
   single word searches last names. Type a haplogroup
   prefix to search (for example, `C1` matches `C1a` but not `J1c1c`), or pick a
   value from the menu. The haplogroup menus fill in with the values fetched
   during a **Start** run (or carried over from saved data). Filtering only
   changes the table, not what **Start** fetches.
4. Click **Start** to load comparisons for the loaded
   relatives. The **Delay (seconds)** and **Retry delay (seconds)** fields set
   the gap between requests (default 2 seconds) and the wait after a failure
   (default 60 seconds); any non-negative value works. **Haplogroup delay
   (seconds)** sets the gap after each per-relative haplogroup request (default
   1 second). Each relative's haplogroup request finishes before that relative's
   comparison request starts, so the two are never in flight together. These
   haplogroup requests run only as part of **Start** (and the automatic fetch
   for newly added relatives), never while browsing. A spinner shows on the
   row being fetched; it becomes **Open** when ready. A progress bar shows how
   many are done and roughly how long is left. If a fetch fails, that same
   relative is retried after the retry delay instead of being skipped, and a
   Chrome notification reports the failure (clicking it opens this page). Click
   **Stop** to cancel the run.
5. To remove saved data for only the selected profile, click **Clear profile
   data** next to the profile selector. This deletes that profile's relatives and
   relatives-in-common records; other profiles are untouched. Selecting the
   profile again reloads its relatives.
6. Click **Open** to see the relatives in common for that pair.
7. Click **Shared DNA** in the top-right toolbar to open the **Shared DNA
   Network**. **Shared matches** is on by default; it adds matches seen under at
   least two relatives. Turn it off to show only direct relatives.

   The profile sits in the middle; blue edges show each relative's direct
   sharing with the profile. Dashed purple edges are links seen from both
   directions; dotted purple edges are only seen from one direction. Drag to
   pan, scroll to zoom, drag a node to pin it, and click a node to see its
   connections in the side panel. By default only the strongest shared links are
   drawn; hover or click a relative to see all of its connections. The **Filter**
   menu narrows the graph by shared cM or haplogroup; its **Full name or last
   name** search only filters the side lists and leaves the graph itself
   unchanged.
8. Click **Data → Export JSON** in the top-right toolbar to save everything in
   the local database to a `.json` file.
9. Click **Data → Import JSON** to load a `.json` file made by **Export**. This
   replaces the whole local database with the file's contents.
10. Click **Data → Delete database** in the top-right toolbar to delete the whole
    local database (all saved relatives and relatives-in-common data) from this
    browser.

The comparison page title and subtitle show the names of the two people in the
pair. For each relative in common it shows:

- avatar and name (or initials when there is no photo), linked to the profile
  on 23andMe
- mtDNA and Y-DNA haplogroups, when they were saved for that relative by a
  **Start** run
- whether they share openly
- every predicted relationship and IBD percentage returned (usually two)
- click an **IBD** column header to sort high-to-low, then click it again for
  low-to-high

Above the table, the same full-name / last-name and mtDNA / Y-DNA filters apply
to the comparison rows.

## Notes

- This is a proof of concept.
- The **Hide names** toggle in the header replaces relative names with initials
  everywhere, including the shared DNA network. The setting is stored locally and
  applies on every page.
- Picking a profile fetches its DNA relatives. On later loads, relatives that
  were not in the previous list are fetched automatically, using the same
  delay, retry, and Stop behavior as **Start**.
- After a comparison is fetched, each match that is also a saved relative and
  already has a saved comparison gets the fetched relative added to its table.
  Copied rows are marked `derived`; the network ignores them when deciding
  whether a link was seen from both directions, because the fetched relative's
  own pair already supplies that connection.
- Relatives that disappear from 23andMe keep their saved comparisons. They are
  not deleted, so they remain in exports and are ready if the relative returns.
  While missing they do not appear in the current list or network, because
  those show the relatives the endpoint currently returns.
- Loading relatives also saves them to IndexedDB (via Dexie, in the
  `relatives-in-common` database): one record in `profile_relatives` per
  selected profile, keyed by its profile id, holding its relatives with every
  field returned by the endpoint, sorted by IBD proportion (highest first).
  Each saved relative also carries its own `haplogroups` object with maternal
  (mtDNA) and paternal (Y-DNA) values, fetched one relative at a time from the
  ancestry compute-result endpoint during a **Start** run.
- Relatives-in-common results are saved to the `relatives_in_common` store with
  every returned field, and every relative in common is kept. Each profile
  record has a `pairs` array; each pair has the relative's id and a `relatives`
  array.
- The comparison page reads its data from IndexedDB.
- The shared DNA network page also reads IndexedDB. A link is drawn when one person
  appears in the other's relatives-in-common list. The row carries two
  relationship/IBD contexts; the common match's own saved direct proportion
  identifies the profile-side context, and the other context becomes the edge
  weight. If the profile-side context cannot be identified, that row is skipped.
  Relationship labels and segment counts are shown in the UI but are not used
  for the graph math. For a common match that is not a saved relative, the
  profile-side column is chosen from how consistent that match's proportions are
  across the lists it appears in, falling back to the column order learned from
  saved relatives. When both directions are available their weights are
  averaged and the link is dashed/confirmed; otherwise it is dotted and marked
  one-sided. **Shared matches** adds only matches seen under at least two
  relatives. The overview draws the 16 strongest shared links; hovering or
  selecting a node reveals all of its links.
- Segment counts are displayed in the tables and details, but they are not used
  as edge weights.
- Node distance from the center reflects direct sharing with the profile
  (stronger sharing is closer) on a logarithmic scale, so each doubling of
  sharing moves a node a similar amount. Links between relatives get shorter as
  their shared proportion grows. The force layout makes exact edge lengths
  approximate; they are not phylogenetic branch lengths.
- The only value stored in `localStorage` is the hide-names preference.
- **Clear profile data** removes only the selected profile's records from both
  IndexedDB stores. **Data → Delete database** removes every profile.
- The shared cM in the main table is estimated from 23andMe's percentage
  (about 74.4 cM per percentage point); the segment count comes from the
  response.
- **Export** writes a JSON file with the format name, version, export time,
  and a `profiles` array. Each profile holds its saved `relatives` list
  (including each relative's `haplogroups`) and its `pairs` list
  (relatives-in-common comparisons), with every returned field kept.
- **Import** validates the JSON format, version, and every profile/pair in a
  first streaming pass, then reads the file again and writes one profile at a
  time. It reads only files made by **Export**.
- **Export** streams the JSON to the save dialog when the browser provides a
  file handle. If that API is unavailable, it falls back to a regular download
  built in memory.
- The UI uses Materialize CSS (MIT), vendored under `vendor/`, with the dark
  theme in `styles/app.css`.
- The comparison is fetched once and then opened instantly.
