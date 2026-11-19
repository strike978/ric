/*
 * Shared Material-style page chrome.
 *
 * The pages use Mithril, so the Materialize CSS classes are applied directly
 * here instead of initializing Materialize components that mutate the DOM.
 */

export function pageUrl(name) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(name);
  }
  return name;
}

export function brandMark() {
  return m('div.mark', { 'aria-hidden': 'true' }, [m('span'), m('span')]);
}

export function appNav({ title, subtitle, actions }) {
  return m('nav.app-nav', m('div.nav-wrapper', m('div.container.nav-inner', [
    m('div.brand', [
      brandMark(),
      m('div', [
        m('h1', title),
        subtitle ? m('p.sub', subtitle) : null,
      ]),
    ]),
    actions && actions.length ? m('div.nav-actions', actions) : null,
  ])));
}
