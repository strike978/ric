/*
 * Streaming JSON reader
 *
 * The file layout is known: a top-level object with a `profiles` array. This
 * reader yields one profile object at a time, so large files do not need to
 * be loaded or parsed all at once.
 */

export const EXPORT_FORMAT = 'relatives-in-common-json';
export const EXPORT_VERSION = 1;

function isWhitespace(ch) {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}

function skipSeparators(text, pos) {
  while (pos < text.length) {
    const ch = text[pos];
    if (ch === ',' || isWhitespace(ch)) {
      pos++;
      continue;
    }
    break;
  }
  return pos;
}

// Finds the end of the object that starts at `start`. Returns -1 when the
// object is not complete in the current buffer.
function findObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return ch === '}' ? i : -1;
      if (depth < 0) return -1;
    }
  }

  return -1;
}

// Returns the index just after the opening `[` of the profiles array.
// -1 = not found yet, -2 = incomplete, -3 = malformed
function findProfilesArray(text) {
  const key = '"profiles"';
  const keyIndex = text.indexOf(key);
  if (keyIndex === -1) return { status: -1, keyIndex: -1 };

  let i = keyIndex + key.length;

  while (i < text.length && isWhitespace(text[i])) i++;
  if (i >= text.length) return { status: -2, keyIndex };
  if (text[i] !== ':') return { status: -3, keyIndex };

  i++;
  while (i < text.length && isWhitespace(text[i])) i++;
  if (i >= text.length) return { status: -2, keyIndex };
  if (text[i] !== '[') return { status: -3, keyIndex };

  return { status: i + 1, keyIndex };
}

export async function* readJsonProfiles(file) {
  if (typeof file.stream !== 'function') {
    throw new Error('this browser cannot stream the selected file');
  }

  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eof = false;

  async function fill() {
    if (eof) return false;

    const { value, done } = await reader.read();
    if (done) {
      eof = true;
      buffer += decoder.decode();
      return false;
    }

    buffer += decoder.decode(value, { stream: true });
    return true;
  }

  // Read until the profiles array is available. The header is small.
  let start = -1;
  let found = null;

  for (;;) {
    found = findProfilesArray(buffer);
    if (found.status >= 0) {
      start = found.status;
      break;
    }
    if (found.status === -3) {
      throw new Error('the profiles array is malformed');
    }
    if (!(await fill())) {
      throw new Error('the export has no profiles array');
    }
  }

  const header = buffer.slice(0, found.keyIndex);
  const cleanHeader = header.replace(/^\uFEFF/, '').trimStart();

  if (!cleanHeader.startsWith('{')) {
    throw new Error('the file does not contain a JSON object');
  }

  const formatPattern = new RegExp(
    '"format"\\s*:\\s*"' + EXPORT_FORMAT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"',
  );
  if (!formatPattern.test(header)) {
    throw new Error('this is not a Relatives in Common JSON export');
  }
  if (!new RegExp('"version"\\s*:\\s*' + EXPORT_VERSION).test(header)) {
    throw new Error('this JSON export uses an unsupported version');
  }

  buffer = buffer.slice(start);
  let pos = 0;

  for (;;) {
    pos = skipSeparators(buffer, pos);

    if (pos >= buffer.length) {
      if (!(await fill())) {
        throw new Error('the profiles array is not closed');
      }
      continue;
    }

    if (buffer[pos] === ']') {
      pos++;

      // Read to the end and make sure nothing unexpected follows.
      while (await fill()) { /* keep reading */ }
      const tail = buffer.slice(pos).trim();
      if (tail !== '' && tail !== '}') {
        throw new Error('unexpected data after the profiles array');
      }
      return;
    }

    if (buffer[pos] !== '{') {
      throw new Error('a profile is not an object');
    }

    let end = findObjectEnd(buffer, pos);

    while (end === -1) {
      if (!(await fill())) {
        throw new Error('a profile object is incomplete');
      }
      end = findObjectEnd(buffer, pos);
    }

    const raw = buffer.slice(pos, end + 1);
    buffer = buffer.slice(end + 1);
    pos = 0;

    let profile;
    try {
      profile = JSON.parse(raw);
    } catch {
      throw new Error('a profile is not valid JSON');
    }

    yield profile;
  }
}
