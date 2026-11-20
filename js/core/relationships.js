/*
 * Relationship label formatting
 *
 * 23andMe returns relationship ids such as "first_cousin" or
 * "first_cousin_once_removed". These helpers turn them into readable text.
 */

const ORDINALS = {
  first: '1st',
  second: '2nd',
  third: '3rd',
  fourth: '4th',
  fifth: '5th',
  sixth: '6th',
  seventh: '7th',
  eighth: '8th',
  ninth: '9th',
  tenth: '10th',
};

export function formatRelationship(value) {
  const text = String(value ?? '').trim();
  if (!text) return '—';

  const words = text
    .split(/[,\-_\s]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      return ORDINALS[lower] || lower.charAt(0).toUpperCase() + lower.slice(1);
    });

  const removedIndex = words.findIndex((word) => word.toLowerCase() === 'removed');
  if (removedIndex > 0) {
    let start = removedIndex;
    const previous = words[removedIndex - 1].toLowerCase();

    if (previous === 'once' || previous === 'twice' || previous === 'thrice' || /^\d+x$/.test(previous)) {
      start = removedIndex - 1;
    } else if (previous === 'times' && removedIndex >= 2) {
      start = removedIndex - 2;
    }

    if (start > 0) {
      return words.slice(0, start).join(' ') + ', ' + words.slice(start).join(' ');
    }
  }

  return words.join(' ');
}
