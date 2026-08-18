import type { Theme } from '@marksyncorg/core';

/**
 * Applies the user's colour theme to the document.
 *
 * The stylesheets carry the light palette on `:root` and override it under
 * `[data-theme='dark']`, so all this has to do is resolve `system` against the browser's
 * own preference and stamp the answer on `<html>`.
 */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

let chosen: Theme = 'system';

function stamp(): void {
  const dark = chosen === 'dark' || (chosen === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  chosen = theme;
  stamp();
}

// The saved theme only arrives once the worker answers, which is a frame or two after the
// page paints. Resolving the system preference up front means that first paint is already
// the right colour in the common case, instead of a light flash on a dark desktop.
stamp();

// `system` keeps following the browser: a preference flipped while the page is open
// repaints it, rather than waiting for the page to be reopened.
darkQuery.addEventListener('change', stamp);
