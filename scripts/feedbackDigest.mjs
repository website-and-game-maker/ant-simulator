/**
 * Pull feedback issues off GitHub and turn them into a triage digest.
 *
 * Run it directly:
 *
 *   node scripts/feedbackDigest.mjs                 # markdown to stdout
 *   node scripts/feedbackDigest.mjs --json          # machine-readable
 *   node scripts/feedbackDigest.mjs --state all     # include closed
 *   node scripts/feedbackDigest.mjs --no-cache      # ignore the cache
 *
 * Works with no credentials at all (the repo is public; GitHub allows 60
 * unauthenticated requests an hour). `GITHUB_TOKEN` raises that to 5000 and is
 * used automatically when present. Responses are cached with their ETag, so a
 * repeat run inside the hour usually costs a single 304 rather than a full
 * page fetch — which matters because 60/hour is easy to burn.
 *
 * The pure functions are exported and unit-tested in
 * `scripts/__tests__/feedbackDigest.test.mjs`; only `main()` touches network
 * or disk.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const DEFAULT_OWNER = 'website-and-game-maker';
export const DEFAULT_REPO = 'ant-simulator';
export const FEEDBACK_LABEL = 'feedback';
export const DIAGNOSTICS_MARKER = 'formicarium-diagnostics';

const CACHE_DIR = '.cache';
const CACHE_FILE = path.join(CACHE_DIR, 'feedback-issues.json');

// ---------------------------------------------------------------------------
// Pure: parsing
// ---------------------------------------------------------------------------

/**
 * Recover the diagnostics our in-game panel embedded in the issue body.
 *
 * The panel writes a ```json fence whose first line is a marker comment. We
 * look for the marker rather than "the first JSON block" because a reporter
 * may well paste other JSON into the same issue, and grabbing theirs would
 * produce confidently wrong triage data.
 */
export function extractDiagnostics(body) {
  if (typeof body !== 'string' || !body.includes(DIAGNOSTICS_MARKER)) return null;
  const fence = /```(?:json)?\s*\n\s*\/\/\s*formicarium-diagnostics\s*\n([\s\S]*?)```/;
  const m = body.match(fence);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    // A truncated or hand-edited block. The issue is still perfectly valid
    // feedback, it just doesn't carry machine-readable state.
    return null;
  }
}

const STOP_WORDS = new Set(
  ('the a an and or but if then than that this these those it its is are was were be been being to of in on at for ' +
    'with from by as i you we they he she my your our their me us them so just really very too much more most some ' +
    'any all can could would should will shall may might do does did done have has had not no yes when what which ' +
    'who whom how why where there here about into over under again also because while during before after ' +
    'feature bug request please thanks thank issue formicarium ant ants sim simulator game')
    .split(/\s+/),
);

/** Content words, lowercased and de-noised, for crude topic matching. */
export function keywords(text) {
  if (typeof text !== 'string') return [];
  const words = text
    .toLowerCase()
    // Drop fenced code and URLs first: both are full of tokens that look like
    // content words and would dominate the overlap score.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && w.length <= 24 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  return Array.from(new Set(words));
}

/** Jaccard similarity of two keyword sets: shared / total distinct. */
export function similarity(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const w of a) if (setB.has(w)) shared++;
  return shared / (a.length + b.length - shared);
}

/** Normalize a GitHub issue into the shape the digest works with. */
export function toRequest(issue) {
  const diagnostics = extractDiagnostics(issue.body);
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
  const thumbsUp = issue.reactions?.['+1'] ?? 0;
  return {
    number: issue.number,
    title: issue.title ?? '',
    url: issue.html_url,
    state: issue.state,
    author: issue.user?.login ?? 'unknown',
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    labels,
    comments: issue.comments ?? 0,
    thumbsUp,
    reactions: issue.reactions?.total_count ?? 0,
    kind: labels.includes('bug')
      ? 'bug'
      : labels.includes('enhancement')
        ? 'feature'
        : labels.includes('balance')
          ? 'balance'
          : labels.includes('praise')
            ? 'praise'
            : 'other',
    diagnostics,
    keywords: keywords(`${issue.title ?? ''} ${issue.body ?? ''}`),
  };
}

// ---------------------------------------------------------------------------
// Pure: clustering and ranking
// ---------------------------------------------------------------------------

/**
 * Greedy single-link clustering of near-duplicate requests.
 *
 * Deliberately crude. The goal is not perfect topic modelling, it is to stop
 * five phrasings of "the ants are too small" from being read as five separate
 * asks — which is exactly the failure mode that makes a raw issue list
 * misleading about what people actually want.
 */
export function clusterRequests(requests, threshold = 0.34) {
  const clusters = [];
  for (const req of requests) {
    let best = null;
    let bestScore = threshold;
    for (const cluster of clusters) {
      const score = Math.max(...cluster.members.map((m) => similarity(req.keywords, m.keywords)));
      if (score >= bestScore) {
        best = cluster;
        bestScore = score;
      }
    }
    if (best) best.members.push(req);
    else clusters.push({ members: [req] });
  }
  return clusters;
}

const DAY_MS = 86_400_000;

/**
 * Score a cluster for triage order.
 *
 * The weights encode a position: **distinct people asking** is the strongest
 * signal, because one person filing four variations of their pet idea should
 * not outrank four people independently hitting the same wall. 👍 is next
 * (it is the cheapest way for a lurker to vote), then discussion volume.
 * Recency is a mild tiebreak, not a driver — a good idea from two months ago
 * is still a good idea. Bugs get a flat bump because a broken thing beats a
 * missing thing.
 */
export function scoreCluster(cluster, now = Date.now()) {
  const members = cluster.members;
  const reporters = new Set(members.map((m) => m.author));
  const thumbsUp = members.reduce((n, m) => n + m.thumbsUp, 0);
  const comments = members.reduce((n, m) => n + m.comments, 0);
  const newest = Math.max(...members.map((m) => Date.parse(m.updatedAt || m.createdAt) || 0));
  const ageDays = Math.max(0, (now - newest) / DAY_MS);
  const recency = Math.exp(-ageDays / 45);
  const isBug = members.some((m) => m.kind === 'bug');

  return (
    reporters.size * 4 +
    thumbsUp * 2.5 +
    comments * 0.7 +
    members.length * 1.5 +
    recency * 3 +
    (isBug ? 3 : 0)
  );
}

export function rankClusters(requests, now = Date.now()) {
  return clusterRequests(requests)
    .map((cluster) => {
      const members = cluster.members.slice().sort((a, b) => b.thumbsUp - a.thumbsUp || a.number - b.number);
      const reporters = new Set(members.map((m) => m.author));
      return {
        title: members[0].title,
        score: scoreCluster(cluster, now),
        members,
        reporters: reporters.size,
        thumbsUp: members.reduce((n, m) => n + m.thumbsUp, 0),
        comments: members.reduce((n, m) => n + m.comments, 0),
        kinds: Array.from(new Set(members.map((m) => m.kind))),
        open: members.filter((m) => m.state === 'open').length,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** Counts worth knowing before reading any individual request. */
export function summarize(requests) {
  const byKind = {};
  const byTier = {};
  const byVersion = {};
  const seeds = [];
  for (const r of requests) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    const tier = r.diagnostics?.sim?.tier;
    if (tier) byTier[tier] = (byTier[tier] ?? 0) + 1;
    const version = r.diagnostics?.app?.version;
    if (version) byVersion[version] = (byVersion[version] ?? 0) + 1;
    const seed = r.diagnostics?.sim?.seed;
    if (typeof seed === 'number' && seed >= 0) seeds.push({ number: r.number, seed });
  }
  return {
    total: requests.length,
    open: requests.filter((r) => r.state === 'open').length,
    reporters: new Set(requests.map((r) => r.author)).size,
    byKind,
    byTier,
    byVersion,
    reproducibleSeeds: seeds,
  };
}

// ---------------------------------------------------------------------------
// Pure: rendering
// ---------------------------------------------------------------------------

function pairs(obj) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}

export function renderDigest(requests, { now = Date.now(), staleNote = '' } = {}) {
  const summary = summarize(requests);
  const ranked = rankClusters(requests, now);
  const out = [];

  out.push('# Formicarium feedback digest');
  out.push('');
  out.push(`_Generated ${new Date(now).toISOString()}_`);
  if (staleNote) out.push(`\n> ⚠️ ${staleNote}`);
  out.push('');

  if (summary.total === 0) {
    out.push('No feedback issues found yet.');
    out.push('');
    out.push(
      'That means either nobody has filed anything, or the `feedback` label is missing from issues that exist. ' +
        'Check the label before concluding it is the former.',
    );
    return out.join('\n');
  }

  out.push(
    `**${summary.total}** report(s) from **${summary.reporters}** reporter(s); ${summary.open} still open.`,
  );
  out.push('');
  out.push(`- By kind: ${pairs(summary.byKind) || '—'}`);
  if (Object.keys(summary.byTier).length) out.push(`- By processing tier: ${pairs(summary.byTier)}`);
  if (Object.keys(summary.byVersion).length) out.push(`- By build: ${pairs(summary.byVersion)}`);
  if (summary.reproducibleSeeds.length) {
    out.push(`- ${summary.reproducibleSeeds.length} report(s) carry a world seed and can be replayed exactly.`);
  }
  out.push('');
  out.push('## Themes, most-wanted first');
  out.push('');

  ranked.forEach((cluster, i) => {
    const badge = cluster.kinds.join('/');
    out.push(`### ${i + 1}. ${cluster.title}`);
    out.push(
      `_${badge} · score ${cluster.score.toFixed(1)} · ${cluster.reporters} reporter(s) · ` +
        `👍 ${cluster.thumbsUp} · ${cluster.comments} comment(s) · ${cluster.open}/${cluster.members.length} open_`,
    );
    out.push('');
    for (const m of cluster.members) {
      const seed = m.diagnostics?.sim?.seed;
      const tier = m.diagnostics?.sim?.tier;
      const extra = [seed !== undefined && seed >= 0 ? `seed \`${seed}\`` : null, tier ? `${tier} tier` : null]
        .filter(Boolean)
        .join(', ');
      out.push(`- [#${m.number}](${m.url}) ${m.title} — @${m.author}${extra ? ` (${extra})` : ''}`);
    }
    out.push('');
  });

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Impure: fetch + cache + CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { json: false, cache: true, state: 'open', owner: DEFAULT_OWNER, repo: DEFAULT_REPO, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--no-cache') args.cache = false;
    else if (a === '--state') args.state = argv[++i] ?? 'open';
    else if (a === '--owner') args.owner = argv[++i] ?? DEFAULT_OWNER;
    else if (a === '--repo') args.repo = argv[++i] ?? DEFAULT_REPO;
    else if (a === '--out') args.out = argv[++i] ?? null;
  }
  return args;
}

async function readCache() {
  try {
    return JSON.parse(await readFile(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(payload) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(payload), 'utf8');
  } catch {
    // A read-only checkout is fine; the cache is an optimisation, not state.
  }
}

/**
 * Fetch every feedback issue, following pagination.
 *
 * Returns `{ issues, stale, note }`. It never throws for an expected network
 * or rate-limit condition: a digest built from an hour-old cache with a loud
 * warning is far more useful than a stack trace, and the caller can still see
 * exactly what it is looking at.
 */
export async function fetchIssues({ owner, repo, state, useCache }) {
  const cache = useCache ? await readCache() : null;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'formicarium-feedback-digest',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  if (cache?.etag && cache.state === state) headers['If-None-Match'] = cache.etag;

  const issues = [];
  let page = 1;
  let etag = null;
  let authNote = '';

  try {
    for (;;) {
      const url =
        `https://api.github.com/repos/${owner}/${repo}/issues` +
        `?labels=${encodeURIComponent(FEEDBACK_LABEL)}&state=${encodeURIComponent(state)}&per_page=100&page=${page}`;
      let res = await fetch(url, { headers });

      // An expired or wrongly-scoped GITHUB_TOKEN shouldn't be worse than no
      // token at all: for a public repo, anonymous access works fine. Drop the
      // credential and carry on rather than failing in front of the user.
      if (res.status === 401 && headers.Authorization) {
        delete headers.Authorization;
        authNote =
          'GITHUB_TOKEN was rejected (401), so this ran unauthenticated at 60 requests/hour. Unset it or replace it to raise the limit.';
        res = await fetch(url, { headers });
      }

      if (res.status === 304 && cache) {
        return { issues: cache.issues, stale: false, note: authNote };
      }
      if (res.status === 403 || res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
        const when = reset ? ` Resets at ${new Date(reset).toISOString()}.` : '';
        // Don't tell someone to set a token they already set — if it was
        // rejected above, the advice is to replace it, not to add one.
        const advice = authNote
          ? ' GITHUB_TOKEN is set but was rejected, so this ran on the anonymous limit; replace the token.'
          : ' Set GITHUB_TOKEN for a much higher limit.';
        if (cache) {
          return {
            issues: cache.issues,
            stale: true,
            note: `GitHub rate-limited this run, so the digest below is from the cache (${cache.fetchedAt}).${when}${advice}`,
          };
        }
        throw new Error(`GitHub rate limit reached and no cache is available.${when}${advice}`);
      }
      if (res.status === 401) {
        throw new Error(`GitHub rejected the request as unauthorized; ${owner}/${repo} may be private. Set a valid GITHUB_TOKEN.`);
      }
      if (res.status === 404) {
        throw new Error(`Repository ${owner}/${repo} not found, or it is private and GITHUB_TOKEN is unset.`);
      }
      if (!res.ok) {
        throw new Error(`GitHub returned ${res.status} ${res.statusText}`);
      }

      if (page === 1) etag = res.headers.get('etag');
      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      // The issues endpoint returns PRs too; they are not feedback.
      issues.push(...batch.filter((i) => !i.pull_request));
      if (batch.length < 100) break;
      page++;
      if (page > 20) break; // 2000 issues is far past anything we'd digest
    }
  } catch (err) {
    if (cache) {
      return {
        issues: cache.issues,
        stale: true,
        note: `Could not reach GitHub (${err.message}); showing the cached digest from ${cache.fetchedAt}.`,
      };
    }
    throw err;
  }

  await writeCache({ etag, state, fetchedAt: new Date().toISOString(), issues });
  return { issues, stale: false, note: authNote };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { issues, note } = await fetchIssues({
    owner: args.owner,
    repo: args.repo,
    state: args.state,
    useCache: args.cache,
  });
  const requests = issues.map(toRequest);

  const output = args.json
    ? JSON.stringify({ summary: summarize(requests), clusters: rankClusters(requests), note }, null, 2)
    : renderDigest(requests, { staleNote: note });

  if (args.out) {
    await writeFile(args.out, output, 'utf8');
    process.stdout.write(`Wrote ${args.out}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }
  return output;
}

// Only run when executed directly, so importing for tests is side-effect free.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`feedback digest failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}
