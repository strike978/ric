/*
 * Person display helpers
 *
 * Shared by the main relatives table, the relatives-in-common table, and the
 * shared DNA network. The avatar uses profile_image_url when available and
 * falls back to initials.
 */

export function displayName(person) {
  const name = [
    person.first_name || person.first_initial,
    person.last_name || person.last_initial,
  ].filter(Boolean).join(' ');

  return name || person.initials || '—';
}

// True when the search text matches the person's full name or last name. A
// single-word search is treated as a last name, so typing a first name alone
// does not match. Used by the name filters on the relatives and shared DNA
// pages.
export function nameMatchesSearch(person, filter) {
  const needle = String(filter || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!needle) return true;

  const first = (person && (person.first_name || person.first_initial)) || '';
  const last = (person && (person.last_name || person.last_initial)) || '';
  const full = [first, last].filter(Boolean).join(' ');
  const lastOnly = String(last || '');

  const normalize = (value) => String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

  // More than one word means a full-name search; one word is a last-name
  // search.
  const haystack = needle.includes(' ') ? normalize(full) : normalize(lastOnly);
  return haystack.includes(needle);
}

export function initialsOf(person) {
  if (person.initials) return String(person.initials).trim().slice(0, 3).toUpperCase();

  const first = person.first_initial || String(person.first_name || '').trim().charAt(0);
  const last = person.last_initial || String(person.last_name || '').trim().charAt(0);
  return (first + last).toUpperCase() || '?';
}

function sexClass(person) {
  const sex = String(person.sex || '').trim().toLowerCase();
  if (sex === 'female' || sex === 'f') return 'female';
  if (sex === 'male' || sex === 'm') return 'male';
  return '';
}

export function avatar(person) {
  const photo = typeof person.profile_image_url === 'string' ? person.profile_image_url : '';
  const sex = sexClass(person);

  return m('span', { class: sex ? 'avatar ' + sex : 'avatar', 'aria-hidden': 'true' }, [
    photo
      ? m('img', {
          src: photo,
          alt: '',
          loading: 'lazy',
          decoding: 'async',
          referrerpolicy: 'no-referrer',
          onerror: (event) => { event.target.style.display = 'none'; },
        })
      : m('span.avatar-initials', initialsOf(person)),
  ]);
}

export function profileUrl(ownerProfileId, profileId) {
  if (!ownerProfileId || !profileId) return null;

  return 'https://you.23andme.com/p/' + encodeURIComponent(ownerProfileId)
    + '/profile/' + encodeURIComponent(profileId) + '/';
}

// The signed-in profile's own home page.
export function ownProfileUrl(profileId) {
  if (!profileId) return null;

  return 'https://you.23andme.com/p/' + encodeURIComponent(profileId) + '/';
}
