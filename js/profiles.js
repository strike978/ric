/*
 * Profile extraction
 *
 * you.23andme.com embeds the signed-in profiles in its HTML as a
 * `new exports.quickInviteModal({ ... })` call. These helpers pull that object's
 * `profiles` array and `currentProfileID` out without eval.
 */

function skipString(src, start) {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === quote) return i;
  }
  return -1;
}

function findClosing(src, openIndex, open, close) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      i = skipString(src, i);
      if (i === -1) return -1;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseProfiles(raw) {
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value)) return value;
  } catch { /* fall through */ }

  // Fallback: pull each top-level {...} out of the array.
  const objects = [];
  let index = raw.indexOf('{');
  while (index !== -1) {
    const end = findClosing(raw, index, '{', '}');
    if (end === -1) break;
    try {
      objects.push(JSON.parse(raw.slice(index, end + 1)));
    } catch { /* skip broken object */ }
    index = raw.indexOf('{', end + 1);
  }
  return objects.length > 0 ? objects : null;
}

export function extractProfiles(html) {
  const anchor = html.indexOf('quickInviteModal');
  if (anchor === -1) return { error: 'quickInviteModal was not found in the response' };

  const profilesMatch = /['"]profiles['"]\s*:\s*\[/g;
  profilesMatch.lastIndex = anchor;
  const match = profilesMatch.exec(html);
  if (!match) return { error: 'the profiles array was not found next to quickInviteModal' };

  const open = match.index + match[0].length - 1;
  const close = findClosing(html, open, '[', ']');
  if (close === -1) return { error: 'the profiles array was not closed properly' };

  const profiles = parseProfiles(html.slice(open, close + 1));
  if (!profiles) return { error: 'the profiles array could not be parsed' };

  const idMatch = /['"]currentProfileID['"]\s*:\s*"([^"]*)"/g;
  idMatch.lastIndex = anchor;
  const current = idMatch.exec(html);

  return {
    data: {
      profiles: profiles.map((profile) => ({
        id: profile.id,
        first_name: profile.first_name,
        last_name: profile.last_name,
      })),
      currentProfileID: current ? current[1] : null,
    },
  };
}
