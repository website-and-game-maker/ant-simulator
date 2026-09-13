/**
 * Identity of this build and of the repository feedback is filed against.
 *
 * The three `__APP_*__` values are substituted by Vite at build time (see
 * `vite.config.ts`). They are declared here rather than in a `.d.ts` so that
 * the fallbacks are real runtime code: `vitest` and any other consumer that
 * doesn't go through Vite's `define` still gets sensible values instead of a
 * ReferenceError.
 */

declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILT_AT__: string;

function defined(read: () => string, fallback: string): string {
  try {
    const v = read();
    return typeof v === 'string' && v.length > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

export const APP_VERSION = defined(() => __APP_VERSION__, '0.0.0-dev');
export const APP_COMMIT = defined(() => __APP_COMMIT__, 'dev');
export const APP_BUILT_AT = defined(() => __APP_BUILT_AT__, 'dev');

/**
 * Where feedback goes. This is the single place the repository is named on the
 * client; `scripts/feedbackDigest.mjs` defaults to the same slug and accepts an
 * override, so a fork only has to change these two defaults.
 */
export const REPO_OWNER = 'website-and-game-maker';
export const REPO_NAME = 'ant-simulator';
export const REPO_SLUG = `${REPO_OWNER}/${REPO_NAME}`;

export const REPO_URL = `https://github.com/${REPO_SLUG}`;
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new`;

/** Existing feedback, newest first — the "has someone already asked for this?"
 * link, and the place to add a 👍 (which is what the digest ranks on). */
export const ISSUES_URL = `${REPO_URL}/issues?q=${encodeURIComponent('is:issue label:feedback sort:reactions-+1-desc')}`;

/** A one-line build stamp for report footers. */
export function buildStamp(): string {
  return `v${APP_VERSION} (${APP_COMMIT})`;
}
