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
   plus the estimated shared cM and number of segments. Click the avatar or
   name to open the relative's profile on 23andMe.
4. Click **Get relatives in common** to fetch comparisons for the loaded
   relatives. The **Delay (seconds)** and **Retry delay (seconds)** fields set
   the gap between requests (default 1.5 seconds) and the wait after a failure
   (default 60 seconds); any non-negative value works. A spinner shows on the
   row being fetched; it becomes **Open** when ready. A progress bar shows how
   many are done and roughly how long is left. If a fetch fails, that same
   relative is retried after the retry delay instead of being skipped, and a
   Chrome notification reports the failure (clicking it opens this page). Click
   **Stop** to cancel the run.
5. Click **Open** to see the relatives in common for that pair.
6. Click **Export** at the bottom of the panel to save everything in the local
   database to a `.db` SQLite file.
7. Click **Import** to load a `.db` file made by **Export**. This replaces the
   whole local database with the file's contents.
8. Click **Delete database** at the bottom of the panel to delete the whole
   local database (all saved relatives and relatives-in-common data) from this
   browser.

The comparison page shows, for each relative in common:

- name, or initials when no name is shown
- profile id, linked to the profile on 23andMe
- whether they share openly
- every predicted relationship and IBD proportion returned (usually two)
- sortable by saved order or any available IBD proportion

## Notes

- This is a proof of concept.
- Picking a profile fetches its DNA relatives, and comparisons are fetched for
  all of them.
- Loading relatives also saves them to IndexedDB (via Dexie, in the
  `relatives-in-common` database): one record in `profile_relatives` per
  selected profile, keyed by its profile id, holding its relatives with every
  field returned by the endpoint, sorted by IBD proportion (highest first).
- Relatives-in-common results are saved to the `relatives_in_common` store with
  every returned field, and every relative in common is kept. Each profile
  record has a `pairs` array; each pair has the relative's id and a `relatives`
  array.
- The comparison page reads its data from IndexedDB; nothing is stored in
  `localStorage`.
- The shared cM in the main table is estimated from 23andMe's percentage
  (about 74.4 cM per percentage point); the segment count comes from the
  response.
- **Export** writes a real SQLite database (`.db`) using
  [sql.js](https://github.com/sql-js/sql.js). The tables are `metadata`,
  `profiles`, `relatives`, `pairs`, and `relatives_in_common`. Every saved field
  becomes its own column, with the field names discovered from the data; common
  fields such as names, IBD proportions, and relationship ids are therefore easy
  to query. Booleans are stored as `0` or `1`, and `row_position` keeps each list
  in its original order. **Import** validates the whole file before replacing
  both stores with its contents. It reads only databases made by **Export**, not
  arbitrary SQLite files.
- The database is built in memory while exporting, so a backup briefly needs
  memory for the whole file.
- SQLite support uses sql.js (MIT), vendored under `vendor/`.
- The comparison is fetched once and then opened instantly.
- If you see a sign-in page or a Cloudflare check, open
  <https://you.23andme.com/> in a normal tab, sign in / clear the check, then reload
  the extension page.
