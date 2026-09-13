import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import pkg from './package.json';

/**
 * Short commit SHA of the build, used to stamp feedback reports so a report
 * can be tied to the exact deployed build rather than "whatever was live that
 * day". CI sets GITHUB_SHA; a local build falls back to asking git; a build
 * from a tarball with no git at all degrades to 'unknown' rather than failing.
 */
function commitSha(): string {
  const fromCi = process.env.GITHUB_SHA;
  if (fromCi) return fromCi.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(commitSha()),
    __APP_BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
