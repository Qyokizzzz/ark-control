import type { MouseEvent } from 'react';

export const pagesDeployment = import.meta.env.MODE === 'github-pages';
export const apiBase = `${import.meta.env.VITE_API_ORIGIN}/api`;
export const faviconUrl = `${import.meta.env.BASE_URL}favicon.svg`;

export function focusPageAnchor(event: MouseEvent<HTMLAnchorElement>) {
  // The fragment is the current route in a Pages build.
  if (!pagesDeployment) return;
  const anchor = document.getElementById(event.currentTarget.hash.slice(1));
  if (!anchor) return;
  event.preventDefault();
  anchor.focus();
  anchor.scrollIntoView();
}
