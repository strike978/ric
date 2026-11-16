# Relatives in Common

A proof-of-concept Chromium extension for getting 23andMe **relatives in common** for
a 23andMe profile.

It uses the 23andMe session already open in your browser. There is no separate login
and no password is stored. Pick a profile, load its DNA relatives, and ask for the
relatives-in-common list for the first two of them.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Click the **Relatives in Common** icon in the toolbar.

## How to use

1. Make sure you are signed in at <https://you.23andme.com> in this browser.
2. Click the extension icon.
3. Pick a profile from the menu.
4. Click **Load relatives** to see that profile's DNA relatives.
5. Click **Get relatives in common** to fetch the comparison for the first two
   rows. A spinner shows on the row being fetched; it becomes **Open** when ready.
6. Click **Open** to see the relatives in common for that pair.

The comparison page shows, for each relative in common:

- initials and name
- profile id
- whether they share openly
- both predicted relationships
- both IBD proportions

## Notes

- This is a proof of concept.
- Only the first two relatives are compared for now.
- Loading relatives also saves them to IndexedDB (via Dexie, in the
  `relatives-in-common` database): one record per selected profile, keyed by
  its profile id, holding its relatives with every field returned by the
  endpoint, sorted by IBD proportion (highest first).
- Relatives-in-common results are saved to the same database under the
  `comparisons` store with every returned field, but only the first two entries
  of each comparison are kept.
- The comparison page reads its data from IndexedDB; nothing is stored in
  `localStorage`.
- The comparison is fetched once and then opened instantly.
- If you see a sign-in page or a Cloudflare check, open
  <https://you.23andme.com/> in a normal tab, sign in / clear the check, then reload
  the extension page.
