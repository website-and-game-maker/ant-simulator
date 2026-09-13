import { describe, expect, it } from 'vitest';
import {
  clusterRequests,
  extractDiagnostics,
  keywords,
  rankClusters,
  renderDigest,
  scoreCluster,
  similarity,
  summarize,
  toRequest,
} from '../feedbackDigest.mjs';

const NOW = Date.parse('2026-09-13T00:00:00Z');

function issue(over = {}) {
  return {
    number: 1,
    title: 'Ants are too small to see',
    body: 'I cannot make out individual ants at default zoom.',
    html_url: 'https://github.com/o/r/issues/1',
    state: 'open',
    user: { login: 'alice' },
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-12T00:00:00Z',
    labels: [{ name: 'feedback' }, { name: 'enhancement' }],
    comments: 0,
    reactions: { '+1': 0, total_count: 0 },
    ...over,
  };
}

describe('extractDiagnostics', () => {
  it('pulls the marked block out of an issue body', () => {
    const body = [
      'The colony starved.',
      '```json',
      '// formicarium-diagnostics',
      '{"sim":{"seed":42,"tier":"medium"}}',
      '```',
    ].join('\n');
    expect(extractDiagnostics(body)).toEqual({ sim: { seed: 42, tier: 'medium' } });
  });

  it('ignores unrelated JSON the reporter pasted', () => {
    const body = ['Here is my config:', '```json', '{"unrelated": true}', '```'].join('\n');
    expect(extractDiagnostics(body)).toBeNull();
  });

  it('returns null for a truncated block instead of throwing', () => {
    const body = ['```json', '// formicarium-diagnostics', '{"sim":{"seed":4', '```'].join('\n');
    expect(extractDiagnostics(body)).toBeNull();
  });

  it('tolerates a missing body', () => {
    expect(extractDiagnostics(undefined)).toBeNull();
    expect(extractDiagnostics(null)).toBeNull();
  });
});

describe('keywords / similarity', () => {
  it('drops stop words, short words and boilerplate', () => {
    const k = keywords('The ants are really very small and I cannot see them');
    expect(k).toContain('small');
    expect(k).not.toContain('ants'); // domain boilerplate in this repo
    expect(k).not.toContain('the');
    expect(k).not.toContain('are');
  });

  it('ignores code fences and URLs', () => {
    const k = keywords('look here https://example.com/zzzqqq ```const zzzcode = 1;```');
    expect(k.join(' ')).not.toContain('zzzcode');
    expect(k.join(' ')).not.toContain('zzzqqq');
  });

  it('scores overlapping topics above unrelated ones', () => {
    const a = keywords('pheromone trails fade far too quickly to follow');
    const b = keywords('scent trails fade quickly and vanish before anyone follows');
    const c = keywords('predator spiders should hunt in packs across terrain');
    expect(similarity(a, b)).toBeGreaterThan(similarity(a, c));
  });

  it('treats an empty set as no similarity', () => {
    expect(similarity([], ['x'])).toBe(0);
  });
});

describe('clustering', () => {
  it('groups rephrasings of the same ask', () => {
    const reqs = [
      issue({ number: 1, title: 'Ants too small', body: 'individual ants tiny hard to see zoom' }),
      issue({ number: 2, title: 'Cannot see the ants', body: 'ants tiny individual hard to see when zoomed' }),
      issue({ number: 3, title: 'Add weather effects', body: 'thunderstorms lightning rainfall puddles please' }),
    ].map(toRequest);
    const clusters = clusterRequests(reqs);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].members).toHaveLength(2);
  });

  it('keeps unrelated requests apart', () => {
    const reqs = [
      issue({ number: 1, title: 'Underground view', body: 'tunnels chambers cutaway nursery' }),
      issue({ number: 2, title: 'Colour blindness', body: 'palette deuteranopia distinguish colonies' }),
    ].map(toRequest);
    expect(clusterRequests(reqs)).toHaveLength(2);
  });
});

describe('scoring', () => {
  it('ranks many distinct reporters above one person filing repeatedly', () => {
    const crowd = clusterRequests(
      [
        issue({ number: 1, user: { login: 'a' }, title: 'trails fade fast', body: 'pheromone trails vanish quickly' }),
        issue({ number: 2, user: { login: 'b' }, title: 'trails fade fast', body: 'pheromone trails vanish quickly' }),
        issue({ number: 3, user: { login: 'c' }, title: 'trails fade fast', body: 'pheromone trails vanish quickly' }),
      ].map(toRequest),
    )[0];
    const solo = clusterRequests(
      [
        issue({ number: 4, user: { login: 'z' }, title: 'beetle armour', body: 'beetles should have armour plating' }),
        issue({ number: 5, user: { login: 'z' }, title: 'beetle armour', body: 'beetles should have armour plating' }),
        issue({ number: 6, user: { login: 'z' }, title: 'beetle armour', body: 'beetles should have armour plating' }),
      ].map(toRequest),
    )[0];
    expect(scoreCluster(crowd, NOW)).toBeGreaterThan(scoreCluster(solo, NOW));
  });

  it('counts a 👍 toward the score', () => {
    const plain = clusterRequests([toRequest(issue({ number: 1 }))])[0];
    const popular = clusterRequests([
      toRequest(issue({ number: 1, reactions: { '+1': 10, total_count: 10 } })),
    ])[0];
    expect(scoreCluster(popular, NOW)).toBeGreaterThan(scoreCluster(plain, NOW));
  });

  it('gives bugs a bump over an otherwise identical feature request', () => {
    const bug = clusterRequests([
      toRequest(issue({ number: 1, labels: [{ name: 'feedback' }, { name: 'bug' }] })),
    ])[0];
    const feature = clusterRequests([toRequest(issue({ number: 1 }))])[0];
    expect(scoreCluster(bug, NOW)).toBeGreaterThan(scoreCluster(feature, NOW));
  });

  it('orders ranked output by descending score', () => {
    const ranked = rankClusters(
      [
        issue({ number: 1, user: { login: 'a' }, title: 'quiet ask', body: 'nobody else mentioned this idea' }),
        issue({ number: 2, user: { login: 'b' }, title: 'loud ask', body: 'terrain rendering looks wrong somehow', reactions: { '+1': 20, total_count: 20 } }),
      ].map(toRequest),
      NOW,
    );
    expect(ranked[0].title).toBe('loud ask');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
});

describe('summarize', () => {
  it('breaks down kind, tier and reproducible seeds', () => {
    const withDiag = issue({
      number: 7,
      labels: [{ name: 'feedback' }, { name: 'bug' }],
      body: ['broken', '```json', '// formicarium-diagnostics', '{"sim":{"seed":99,"tier":"low"},"app":{"version":"1.2.3"}}', '```'].join('\n'),
    });
    const s = summarize([toRequest(issue()), toRequest(withDiag)]);
    expect(s.total).toBe(2);
    expect(s.byKind).toEqual({ feature: 1, bug: 1 });
    expect(s.byTier).toEqual({ low: 1 });
    expect(s.byVersion).toEqual({ '1.2.3': 1 });
    expect(s.reproducibleSeeds).toEqual([{ number: 7, seed: 99 }]);
  });
});

describe('renderDigest', () => {
  it('renders themes with their evidence', () => {
    const md = renderDigest([toRequest(issue())], { now: NOW });
    expect(md).toContain('# Formicarium feedback digest');
    expect(md).toContain('Ants are too small to see');
    expect(md).toContain('[#1](https://github.com/o/r/issues/1)');
    expect(md).toContain('@alice');
  });

  it('says so plainly when there is nothing', () => {
    const md = renderDigest([], { now: NOW });
    expect(md).toContain('No feedback issues found');
    expect(md).toContain('label');
  });

  it('surfaces a stale-cache warning at the top', () => {
    const md = renderDigest([toRequest(issue())], { now: NOW, staleNote: 'served from cache' });
    expect(md).toContain('⚠️');
    expect(md).toContain('served from cache');
  });

  it('shows the seed so a report can be replayed', () => {
    const withDiag = issue({
      body: ['x', '```json', '// formicarium-diagnostics', '{"sim":{"seed":1873402231,"tier":"medium"}}', '```'].join('\n'),
    });
    expect(renderDigest([toRequest(withDiag)], { now: NOW })).toContain('seed `1873402231`');
  });
});
