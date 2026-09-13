import { describe, expect, it } from 'vitest';
import { composeIssue, composeMarkdown, labelsFor, titleFor, MAX_URL_LENGTH } from '../feedbackCompose';
import { DIAGNOSTICS_MARKER } from '../diagnostics';

const diagnostics = {
  app: { version: '1.0.0', commit: 'abc1234', builtAt: 'now', url: 'https://x/', capturedAt: 'now', sessionSeconds: 30 },
  sim: {
    seed: 1873402231,
    tier: 'medium',
    speed: 1,
    paused: false,
    view: 'surface',
    day: 4,
    clock: '12:30',
    simTimeSeconds: 540,
    worldSize: '3600x2200',
    ants: 40,
    larvae: 3,
    colonies: 2,
    predators: 1,
    birthsPerMinute: 6,
    deathsPerMinute: 4,
    deathsByCause: { starvation: 21 },
    weather: 'clear',
    fps: 60,
    simMsPerFrame: 2.5,
  },
  colonies: ['Granitecrest: 19 ants, 204 food, queen alive'],
  env: { userAgent: 'test', viewport: '1440x900', devicePixelRatio: 2, touch: false, reducedMotion: false },
} as unknown as Record<string, unknown>;

const entry = (over: Partial<{ title: string; body: string; diagnostics: Record<string, unknown> | null }> = {}) => ({
  kind: 'bug' as const,
  title: 'Ants ignore adjacent food',
  body: 'They walk right past a seed pile.',
  diagnostics,
  ...over,
});

describe('composeIssue', () => {
  it('includes the full report when it fits', () => {
    const r = composeIssue(entry());
    expect(r.diagnosticsDropped).toBe(false);
    expect(r.bodyTruncated).toBe(false);
    expect(r.body).toContain('They walk right past a seed pile.');
    expect(r.body).toContain(DIAGNOSTICS_MARKER);
    expect(r.body).toContain('1873402231');
    expect(r.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
  });

  it('prefixes the title and applies both labels', () => {
    const r = composeIssue(entry());
    expect(r.title).toBe('[Bug] Ants ignore adjacent food');
    expect(r.labels).toEqual(['feedback', 'bug']);
    expect(r.url).toContain(encodeURIComponent('feedback,bug'));
  });

  it('drops diagnostics before touching the user’s own words', () => {
    const bulky = { ...diagnostics, filler: 'x'.repeat(9000) };
    const r = composeIssue(entry({ diagnostics: bulky }));
    expect(r.diagnosticsDropped).toBe(true);
    expect(r.bodyTruncated).toBe(false);
    expect(r.body).toContain('They walk right past a seed pile.');
    expect(r.body).toContain('too large to include');
    expect(r.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
  });

  it('truncates very long prose only as a last resort, and stays in budget', () => {
    const r = composeIssue(entry({ body: 'sentence. '.repeat(3000), diagnostics: null }));
    expect(r.bodyTruncated).toBe(true);
    expect(r.body).toContain('_(truncated)_');
    expect(r.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
  });

  it('stays within budget even when the text is entirely multi-byte', () => {
    // Each of these costs ~12 chars once percent-encoded, so a naive
    // character-count budget would overshoot badly here.
    const r = composeIssue(entry({ body: '🐜🌿🪨'.repeat(2000), diagnostics: null }));
    expect(r.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
  });

  it('survives a lone surrogate pasted into the middle of a report', () => {
    const r = composeIssue(entry({ body: `before \ud83d after`, diagnostics: null }));
    expect(r.url).toContain('title=');
    expect(() => decodeURIComponent(r.url)).not.toThrow();
  });

  it('handles an empty body without producing a broken URL', () => {
    const r = composeIssue(entry({ body: '', diagnostics: null }));
    expect(r.url.startsWith('https://')).toBe(true);
    expect(r.url).toContain('title=');
  });

  it('maps each kind to its triage label', () => {
    expect(labelsFor('feature')).toEqual(['feedback', 'enhancement']);
    expect(labelsFor('balance')).toEqual(['feedback', 'balance']);
    expect(titleFor({ kind: 'praise', title: 'lovely' })).toBe('[Praise] lovely');
  });
});

describe('composeMarkdown', () => {
  it('is always complete, with no URL budget applied', () => {
    const bulky = { ...diagnostics, filler: 'x'.repeat(9000) };
    const md = composeMarkdown(entry({ diagnostics: bulky }));
    expect(md).toContain(DIAGNOSTICS_MARKER);
    expect(md).toContain('x'.repeat(100));
    expect(md).toContain('They walk right past a seed pile.');
  });
});
