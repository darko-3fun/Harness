'use client';

import { useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark';

/**
 * Theme lives on <html data-theme>, set before hydration by the inline script in
 * layout.tsx so there is no flash. This component only reads and toggles it; the
 * DOM attribute is the store, and a custom event is the subscription.
 */
const EVENT = 'harness-theme';

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
const read = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
const readServer = (): Theme => 'light';

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, read, readServer);

  function toggle() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('harness-theme', next);
    } catch {
      /* storage may be unavailable; the attribute still applies */
    }
    window.dispatchEvent(new Event(EVENT));
  }

  return (
    <button
      className="btn"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
      title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
    >
      {theme === 'light' ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      )}
      {theme === 'light' ? 'Dark' : 'Light'}
    </button>
  );
}
