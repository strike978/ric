/*
 * Display preferences
 *
 * Hide-names is stored in localStorage so the shared header toggle applies on
 * every page and survives reloads.
 */

import { displayName, initialsOf } from './person.js';

const STORAGE_KEY = 'relatives-in-common:hide-names';

function storedHideNames() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export const preferences = {
  hideNames: storedHideNames(),
};

export function setHideNames(value) {
  preferences.hideNames = Boolean(value);

  try {
    localStorage.setItem(STORAGE_KEY, preferences.hideNames ? '1' : '0');
  } catch {
    /* ignore storage failures */
  }
}

// Full name normally, initials when names are hidden.
export function labelName(person) {
  return preferences.hideNames ? initialsOf(person) : displayName(person);
}

// Initials for a name string, used for the comparison subtitle.
export function initialsOfName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();

  return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
}
