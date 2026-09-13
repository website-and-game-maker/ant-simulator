/**
 * Turning a feedback entry into something GitHub will accept.
 *
 * Split out from the UI because the interesting part — fitting a report into a
 * URL — is pure logic with sharp edges worth testing directly.
 *
 * GitHub rejects a new-issue URL somewhere around 8 KB with a 414, and it does
 * it *after* the user has clicked, logged in, and waited. A report carrying a
 * couple of pages of diagnostics plus a long description sails past that, so
 * the body has to be fitted to a budget before it is ever sent.
 */

import { DIAGNOSTICS_MARKER, diagnosticsToMarkdown, type Diagnostics } from './diagnostics';
import { NEW_ISSUE_URL, buildStamp } from '../appInfo';
import type { FeedbackEntry, FeedbackKind } from './feedbackStore';

/**
 * Budget for the whole URL. GitHub starts refusing around 8192; browsers and
 * intermediate proxies impose their own limits. 6000 leaves comfortable room
 * for the origin, the query keys and percent-encoding overhead.
 */
export const MAX_URL_LENGTH = 6000;

export const KIND_LABEL: Record<FeedbackKind, string> = {
  feature: 'feature request',
  bug: 'bug',
  balance: 'balance',
  praise: 'praise',
  other: 'feedback',
};

/** Labels applied to the filed issue. `feedback` is the one the digest keys
 * off; the second is the triage hint. */
export function labelsFor(kind: FeedbackKind): string[] {
  const second: Record<FeedbackKind, string> = {
    feature: 'enhancement',
    bug: 'bug',
    balance: 'balance',
    praise: 'praise',
    other: 'question',
  };
  return ['feedback', second[kind]];
}

export function titleFor(entry: Pick<FeedbackEntry, 'kind' | 'title'>): string {
  const prefix: Record<FeedbackKind, string> = {
    feature: '[Feature]',
    bug: '[Bug]',
    balance: '[Balance]',
    praise: '[Praise]',
    other: '[Feedback]',
  };
  return `${prefix[entry.kind]} ${entry.title}`.slice(0, 240);
}

/**
 * Remove unpaired surrogates.
 *
 * `encodeURIComponent` throws `URIError` on a lone surrogate, which would take
 * down the whole submit path. Halves get separated two ways: a paste can carry
 * a broken one in, and — the case that actually bit — slicing a string at an
 * arbitrary index lands between the two halves of an astral character like an
 * emoji. Since a lone surrogate is unrenderable anyway, dropping it loses
 * nothing a reader would have seen.
 */
function stripLoneSurrogates(text: string): string {
  // Any high surrogate not followed by a low one, or low not preceded by high.
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

/**
 * Cut text at a paragraph or line boundary when possible, so a truncated
 * report ends on a readable sentence rather than mid-word.
 */
function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const slice = stripLoneSurrogates(text.slice(0, limit));
  const cut = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), slice.lastIndexOf('. '));
  const kept = cut > limit * 0.5 ? slice.slice(0, cut) : slice;
  return { text: `${kept.trimEnd()}\n\n_(truncated)_`, truncated: true };
}

export interface ComposeResult {
  title: string;
  body: string;
  labels: string[];
  url: string;
  /** True when the diagnostics block had to be dropped to fit. */
  diagnosticsDropped: boolean;
  /** True when the user's own text had to be shortened to fit. */
  bodyTruncated: boolean;
}

/**
 * Build the issue body and the prefilled URL, shrinking to fit the budget.
 *
 * Order matters: the user's own words are the point of the report, so the
 * machine-generated diagnostics are sacrificed first and their prose only
 * after that. When diagnostics are dropped the body says so and points at the
 * export, so the information is still recoverable rather than silently gone.
 */
export function composeIssue(
  entry: Pick<FeedbackEntry, 'kind' | 'title' | 'body' | 'diagnostics'>,
  opts: { newIssueUrl?: string; maxUrlLength?: number } = {},
): ComposeResult {
  const base = opts.newIssueUrl ?? NEW_ISSUE_URL;
  const budget = opts.maxUrlLength ?? MAX_URL_LENGTH;
  const title = titleFor(entry);
  const labels = labelsFor(entry.kind);

  const diagnosticsMd = entry.diagnostics
    ? diagnosticsToMarkdown(entry.diagnostics as unknown as Diagnostics)
    : '';

  const build = (prose: string, diags: string, note: string) =>
    [prose.trim(), note, diags && '---', diags, `\n<sub>Filed from Formicarium ${buildStamp()}</sub>`]
      .filter(Boolean)
      .join('\n\n');

  const assemble = (prose: string, diags: string, note: string) => {
    const body = stripLoneSurrogates(build(prose, diags, note));
    const url = `${base}?title=${encodeURIComponent(title)}&labels=${encodeURIComponent(labels.join(','))}&body=${encodeURIComponent(body)}`;
    return { body, url };
  };

  // 1. Everything.
  let attempt = assemble(entry.body, diagnosticsMd, '');
  if (attempt.url.length <= budget) {
    return { title, body: attempt.body, labels, url: attempt.url, diagnosticsDropped: false, bodyTruncated: false };
  }

  // 2. Drop diagnostics.
  const droppedNote = diagnosticsMd
    ? '> _Diagnostics were too large to include in this link. Ask the reporter for the JSON export from the in-game feedback panel if you need them._'
    : '';
  attempt = assemble(entry.body, '', droppedNote);
  if (attempt.url.length <= budget) {
    return { title, body: attempt.body, labels, url: attempt.url, diagnosticsDropped: true, bodyTruncated: false };
  }

  // 3. Shorten the prose. Binary search the longest prefix that fits, since
  // percent-encoding makes the encoded length a non-obvious function of the
  // source length (one emoji can cost a dozen characters).
  let lo = 0;
  let hi = entry.body.length;
  let best = '';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = truncate(entry.body, mid).text;
    if (assemble(candidate, '', droppedNote).url.length <= budget) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  attempt = assemble(best, '', droppedNote);
  return { title, body: attempt.body, labels, url: attempt.url, diagnosticsDropped: true, bodyTruncated: true };
}

/** The same report as plain Markdown, for the clipboard path — no URL budget,
 * so this is always complete. */
export function composeMarkdown(entry: Pick<FeedbackEntry, 'kind' | 'title' | 'body' | 'diagnostics'>): string {
  const diags = entry.diagnostics ? diagnosticsToMarkdown(entry.diagnostics as unknown as Diagnostics) : '';
  return [
    `## ${titleFor(entry)}`,
    '',
    entry.body.trim(),
    diags ? '\n---\n' : '',
    diags,
    `\n<sub>Filed from Formicarium ${buildStamp()}</sub>`,
  ]
    .filter(Boolean)
    .join('\n');
}

export { DIAGNOSTICS_MARKER };
