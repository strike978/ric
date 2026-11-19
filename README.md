# Relatives in Common

A proof-of-concept Chromium extension for getting 23andMe **relatives in common** for
a 23andMe profile.

It uses the 23andMe session already open in your browser. There is no separate login
and no password is stored. Pick a profile, load its DNA relatives, and ask for each
one's relatives-in-common list. The saved comparisons can also be viewed as a
pairwise IBD matrix and grouped by shared relatives.

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
4. Click **Fetch** to load comparisons for the loaded
   relatives. The **Delay (seconds)** and **Retry delay (seconds)** fields set
   the gap between requests (default 3 seconds) and the wait after a failure
   (default 60 seconds); any non-negative value works. A spinner shows on the
   row being fetched; it becomes **Open** when ready. A progress bar shows how
   many are done and roughly how long is left. If a fetch fails, that same
   relative is retried after the retry delay instead of being skipped, and a
   Chrome notification reports the failure (clicking it opens this page). Click
   **Stop** to cancel the run.
5. Click **Open** to see the relatives in common for that pair.
6. Click **IBD matrix** to open the matrix and shared-relative networks
   for the selected profile. See below for what the page shows.
7. Click **Export** in the top-right toolbar to save everything in the local
   database to a `.json` file.
8. Click **Import** to load a `.json` file made by **Export**. This replaces the
   whole local database with the file's contents.
9. Click **Delete** in the top-right toolbar to delete the whole local database
   (all saved relatives and relatives-in-common data) from this browser.

The comparison page title and subtitle show the names of the two people in the
pair. For each relative in common it shows:

- avatar and name (or initials when there is no photo), linked to the profile
  on 23andMe
- whether they share openly
- every predicted relationship and IBD percentage returned (usually two)
- sortable by saved order or any available IBD percentage

## Relatedness matrix

The matrix page reads the selected profile's saved data and turns it into a
pairwise relatedness graph. It makes no new requests.

- **Matrix**: rows and columns are the selected profile plus its relatives.
  Cells show **IBD** — identical-by-descent sharing — not the estimated shared
  DNA percentage. The default is the IBD segment count; the metric picker can
  switch to IBD proportion. Click a filled cell to open pair details.
- **Pair details**: both profile IDs and names, IBD proportion, IBD segment
  count, the predicted relationship in each direction, and the list of shared
  matches. Each shared match shows its ID, name, predicted relationship to both
  people, and its IBD proportion and segment count with both.
- **Family groups**: two relatives are linked when they have at least the
  chosen **Min shared matches** in common (3 by default). Connected relatives
  form family groups. The matrix is ordered and color-coded by group, with a
  labeled group band across the columns and down the rows. The **Family group**
  picker narrows it to one group. Raise the minimum to split very broad groups;
  lower it to merge them.

How a link is found: a saved relatives-in-common row for the pair
`(selected profile, relative X)` lists a shared match `Y` with two sides. One
side is `Y`'s relationship and IBD sharing with the selected profile, and the
other is `Y`'s relationship and IBD sharing with `X`. The owner side is matched
against the selected profile's saved relatives list, and the other side becomes
the `X`–`Y` link. Two relatives' shared matches are the intersection of both
saved lists. Family groups are built from the overlap of those shared-match
sets: relatives X and Z are linked when they have at least the chosen number of
shared matches in common.

The matrix is only as complete as the saved comparisons. If
**Fetch** has not been run, the matrix shows direct links to
the selected profile but no relative-to-relative networks.

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
- The comparison and matrix pages read their data from IndexedDB; nothing is
  stored in `localStorage`.
- The shared cM in the main table is estimated from 23andMe's percentage
  (about 74.4 cM per percentage point); the segment count comes from the
  response.
- **Export** writes a JSON file with the format name, version, export time,
  and a `profiles` array. Each profile holds its saved `relatives` list and its
  `pairs` list (relatives-in-common comparisons), with every returned field kept.
- **Import** validates the JSON format, version, and every profile/pair in a
  first streaming pass, then reads the file again and writes one profile at a
  time. It reads only files made by **Export**.
- **Export** streams the JSON to the save dialog when the browser provides a
  file handle. If that API is unavailable, it falls back to a regular download
  built in memory.
- The UI uses Materialize CSS (MIT), vendored under `vendor/`, with a dark
  theme override in `styles/material-dark.css`.
- The comparison is fetched once and then opened instantly.
- If you see a sign-in page or a Cloudflare check, open
  <https://you.23andme.com/> in a normal tab, sign in / clear the check, then reload
  the extension page.
