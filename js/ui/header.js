/*
 * Shared page header
 *
 * One Mithril component used by every page: brand, page title/subtitle,
 * hide-names switch, and optional right-side actions.
 */

import { preferences, setHideNames } from '../core/preferences.js';

export function pageUrl(name) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(name);
  }
  return name;
}

function icon(path) {
  return m('svg.nav-icon', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }, m('path', { d: path }));
}

function brandMark() {
  return m('div.mark', { 'aria-hidden': 'true' }, [m('span'), m('span')]);
}

function namesSwitch() {
  const active = preferences.hideNames;

  return m('button', {
    type: 'button',
    class: active ? 'nav-switch on' : 'nav-switch',
    role: 'switch',
    'aria-checked': active ? 'true' : 'false',
    title: active ? 'Show relative names' : 'Hide relative names and show initials',
    onclick: () => {
      setHideNames(!active);
      m.redraw.sync();
    },
  }, [
    m('span.nav-switch-icon', icon('M3 3l18 18M10.6 10.7a2 2 0 002.7 2.7M9.9 5.2A9.8 9.8 0 0112 5c5 0 9 4.5 9 7a11.5 11.5 0 01-2.1 3.1M6.2 6.2C3.8 7.8 3 10.2 3 12c0 2.5 4 7 9 7a10 10 0 004.2-.9')),
    m('span.nav-switch-track', m('span.nav-switch-thumb')),
    m('span.nav-switch-label', 'Hide names'),
  ]);
}

function closeMenu(event) {
  const details = event.currentTarget.closest('details');
  if (details) details.open = false;
}

export function dataMenu({
  busy,
  exporting,
  importing,
  deleting,
  onExport,
  onImport,
  onDelete,
}) {
  return m('details.nav-menu', [
    m('summary.nav-menu-trigger', [
      m('span', 'Data'),
      m('span.nav-caret', { 'aria-hidden': 'true' }, '▾'),
    ]),
    m('div.nav-menu-panel', [
      m('button.nav-menu-item', {
        type: 'button',
        disabled: busy,
        onclick: (event) => {
          closeMenu(event);
          onExport();
        },
      }, [
        icon('M12 3v12m0 0l-4-4m4 4l4-4M5 21h14'),
        m('span', exporting ? 'Exporting…' : 'Export JSON'),
      ]),
      m('button.nav-menu-item', {
        type: 'button',
        disabled: busy,
        onclick: (event) => {
          closeMenu(event);
          onImport();
        },
      }, [
        icon('M12 21V9m0 0l-4 4m4-4l4 4M5 3h14'),
        m('span', importing ? 'Importing…' : 'Import JSON'),
      ]),
      m('div.nav-menu-separator'),
      m('button.nav-menu-item.nav-danger', {
        type: 'button',
        disabled: busy,
        onclick: (event) => {
          closeMenu(event);
          onDelete();
        },
      }, [
        icon('M4 7h16M9 7V4h6v3m-8 0l1 14h8l1-14'),
        m('span', deleting ? 'Deleting…' : 'Delete database'),
      ]),
    ]),
  ]);
}

export function appHeader({ title, subtitle, actions }) {
  return m('nav.app-nav', m('div.nav-wrapper', m('div.container.nav-inner', [
    m('div.brand', [
      brandMark(),
      m('div', [
        m('h1', title),
        subtitle ? m('p.sub', subtitle) : null,
      ]),
    ]),
    m('div.nav-actions', [
      ...(actions || []),
      actions && actions.length ? m('span.nav-divider') : null,
      namesSwitch(),
    ]),
  ])));
}
