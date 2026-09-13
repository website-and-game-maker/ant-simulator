/**
 * Durable local storage for feedback the player has written.
 *
 * Formicarium is a static site with no backend, so a report's journey is:
 * written here → persisted locally → opened as a prefilled GitHub issue. The
 * middle step is the reason this file exists. Between writing a report and
 * actually filing it, the player has to survive a popup blocker, a GitHub
 * login redirect, an accidental tab close, and their own second thoughts.
 * Anything that only lived in a form field would be gone. Everything written
 * here survives all of that, and `exportJson()` can hand the lot over even if
 * GitHub was never reached at all.
 *
 * The hard requirement is that **storage failure must never lose the report in
 * front of the user**. Every browser storage API can throw — Safari private
 * mode historically threw on every write, storage can be disabled by policy,
 * and quota is finite. So this store keeps an in-memory copy as the source of
 * truth for the session and treats localStorage as a best-effort mirror. If
 * the mirror fails, the UI still works for as long as the tab is open and the
 * user is told plainly that their history won't persist.
 */

export const FEEDBACK_SCHEMA_VERSION = 2;

const STORAGE_KEY = 'formicarium-feedback-v2';
/** Older key, read once and migrated forward. */
const LEGACY_KEY = 'formicarium-feedback-v1';

/**
 * Hard cap on retained entries. Feedback is small, but an unbounded array in
 * localStorage is a slow leak that eventually breaks an unrelated feature by
 * exhausting the origin's quota.
 */
export const MAX_ENTRIES = 200;

/** Cap on one entry's free text, enforced at the store so an enormous paste
 * can't single-handedly blow the quota. The UI enforces a smaller limit. */
const MAX_TEXT = 20_000;

export type FeedbackKind = 'feature' | 'bug' | 'balance' | 'praise' | 'other';

export type FeedbackStatus =
  /** Written but never sent anywhere. */
  | 'draft'
  /** We opened a prefilled GitHub issue form; whether they pressed Submit on
   * GitHub is something a static page fundamentally cannot observe. */
  | 'opened'
  /** The user confirmed they filed it, or pasted the resulting issue URL. */
  | 'filed';

export interface FeedbackEntry {
  id: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  /** Attached diagnostics as an opaque record, or null when the user opted
   * out. Typed loosely on purpose: the store must round-trip whatever shape
   * `diagnostics.ts` produces today without needing to change alongside it. */
  diagnostics: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  status: FeedbackStatus;
  openedAt?: number;
  filedAt?: number;
  /** Issue URL, once known. */
  issueUrl?: string;
}

export interface PersistOutcome {
  ok: boolean;
  /** Set when ok is false — a short, user-facing explanation. */
  problem?: string;
  /** How many old entries were dropped to make room, if any. */
  pruned?: number;
}

interface Envelope {
  version: number;
  entries: FeedbackEntry[];
}

// ---------------------------------------------------------------------------
// Storage backend
// ---------------------------------------------------------------------------

/** The slice of the Storage API this module uses. Injectable so tests can
 * drive quota exhaustion and hostile getters without a browser. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Resolve a usable storage, or null.
 *
 * Merely reading `window.localStorage` can throw (`SecurityError` when cookies
 * are blocked), and in some configurations it is present but throws on write,
 * so presence is probed with an actual round-trip rather than a truthiness
 * check.
 */
function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__formicarium_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Chrome/Firefox use QuotaExceededError; Safari has historically used the
  // legacy code 22, and in private mode a differently-named error entirely.
  const name = err.name;
  const code = (err as unknown as { code?: number }).code;
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  );
}

// ---------------------------------------------------------------------------
// Parsing / validation
// ---------------------------------------------------------------------------

const KINDS: readonly FeedbackKind[] = ['feature', 'bug', 'balance', 'praise', 'other'];
const STATUSES: readonly FeedbackStatus[] = ['draft', 'opened', 'filed'];

function str(v: unknown, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Coerce one persisted record into a valid entry, or drop it.
 *
 * Stored JSON is not trusted input in the security sense, but it *is*
 * untrusted in the practical sense: it may have been written by an older build
 * with a different shape, or hand-edited in devtools. One malformed record
 * must not take the whole history down with it, so anything unusable is
 * skipped and the rest still loads.
 */
function parseEntry(raw: unknown): FeedbackEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const id = str(r.id, 80);
  const title = str(r.title, 400);
  const body = str(r.body);
  if (!id || (!title && !body)) return null;

  const created = num(r.createdAt, Date.now());
  const kind = KINDS.includes(r.kind as FeedbackKind) ? (r.kind as FeedbackKind) : 'other';
  const status = STATUSES.includes(r.status as FeedbackStatus) ? (r.status as FeedbackStatus) : 'draft';

  let diagnostics: Record<string, unknown> | null = null;
  if (r.diagnostics && typeof r.diagnostics === 'object' && !Array.isArray(r.diagnostics)) {
    diagnostics = r.diagnostics as Record<string, unknown>;
  }

  const entry: FeedbackEntry = {
    id,
    kind,
    title,
    body,
    diagnostics,
    createdAt: created,
    updatedAt: num(r.updatedAt, created),
    status,
  };
  if (typeof r.openedAt === 'number') entry.openedAt = r.openedAt;
  if (typeof r.filedAt === 'number') entry.filedAt = r.filedAt;
  const url = str(r.issueUrl, 400);
  // Only http(s): a stored `javascript:` URL would otherwise be handed
  // straight to an anchor's href by the UI.
  if (/^https?:\/\//i.test(url)) entry.issueUrl = url;
  return entry;
}

function parseEnvelope(text: string | null): FeedbackEntry[] {
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  // v1 was a bare array; v2 wraps it so the version travels with the data.
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as Envelope | null)?.entries)
      ? (data as Envelope).entries
      : [];
  const out: FeedbackEntry[] = [];
  for (const raw of list) {
    const parsed = parseEntry(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

// ---------------------------------------------------------------------------

export function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `fb_${crypto.randomUUID()}`;
    }
  } catch {
    /* fall through */
  }
  return `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface FeedbackStoreOptions {
  storage?: StorageLike | null;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

export class FeedbackStore {
  private entries: FeedbackEntry[] = [];
  private storage: StorageLike | null;
  private now: () => number;
  /** True once a write has failed for a reason that won't fix itself, so the
   * UI can say "history won't be kept" exactly once instead of per keystroke. */
  private degraded = false;

  constructor(opts: FeedbackStoreOptions = {}) {
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.now = opts.now ?? (() => Date.now());
    this.load();
  }

  /** Whether persistence is working. False means this session's history is
   * in memory only. */
  get persistent(): boolean {
    return this.storage !== null && !this.degraded;
  }

  private load() {
    if (!this.storage) return;
    let text: string | null = null;
    try {
      text = this.storage.getItem(STORAGE_KEY);
    } catch {
      this.storage = null;
      return;
    }

    if (text === null) {
      // Migrate a v1 payload forward, then retire the old key. Done once: if
      // the rewrite fails we keep the legacy key so the next load retries.
      try {
        const legacy = this.storage.getItem(LEGACY_KEY);
        if (legacy) {
          this.entries = parseEnvelope(legacy);
          if (this.persist().ok) this.storage.removeItem(LEGACY_KEY);
          return;
        }
      } catch {
        /* migration is best-effort */
      }
    }

    this.entries = parseEnvelope(text);
    this.sort();
  }

  private sort() {
    this.entries.sort((a, b) => b.createdAt - a.createdAt);
  }

  private serialize(entries: FeedbackEntry[]): string {
    const envelope: Envelope = { version: FEEDBACK_SCHEMA_VERSION, entries };
    return JSON.stringify(envelope);
  }

  /**
   * Write to storage, shedding load if the quota rejects us.
   *
   * Escalates in the order that loses least: first drop entries already sent
   * to GitHub (they exist upstream now), then strip diagnostics off old
   * entries (bulky, and stale diagnostics are worth little), then drop the
   * oldest entries outright. The newest entry — the one the user is most
   * likely looking at right now — is the last thing to go.
   */
  private persist(): PersistOutcome {
    if (!this.storage) return { ok: false, problem: 'Browser storage is unavailable.' };

    const attempt = (entries: FeedbackEntry[]): boolean => {
      try {
        this.storage!.setItem(STORAGE_KEY, this.serialize(entries));
        return true;
      } catch (err) {
        if (!isQuotaError(err)) throw err;
        return false;
      }
    };

    try {
      if (attempt(this.entries)) return { ok: true };

      let pruned = 0;
      const working = this.entries.slice();

      // 1. Entries already filed upstream.
      for (let i = working.length - 1; i >= 0 && working.length > 1; i--) {
        if (working[i].status === 'filed') {
          working.splice(i, 1);
          pruned++;
          if (attempt(working)) {
            this.entries = working;
            return { ok: true, pruned };
          }
        }
      }

      // 2. Diagnostics on everything but the newest entry.
      for (let i = working.length - 1; i >= 1; i--) {
        if (working[i].diagnostics) {
          working[i] = { ...working[i], diagnostics: null };
          if (attempt(working)) {
            this.entries = working;
            return { ok: true, pruned };
          }
        }
      }

      // 3. Oldest first, never the newest.
      while (working.length > 1) {
        working.pop();
        pruned++;
        if (attempt(working)) {
          this.entries = working;
          return { ok: true, pruned };
        }
      }

      this.degraded = true;
      return { ok: false, problem: 'Browser storage is full.', pruned };
    } catch {
      // A non-quota throw means storage stopped working mid-session.
      this.storage = null;
      this.degraded = true;
      return { ok: false, problem: 'Browser storage stopped responding.' };
    }
  }

  list(): FeedbackEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  get(id: string): FeedbackEntry | null {
    const found = this.entries.find((e) => e.id === id);
    return found ? { ...found } : null;
  }

  get size(): number {
    return this.entries.length;
  }

  add(input: {
    kind: FeedbackKind;
    title: string;
    body: string;
    diagnostics?: Record<string, unknown> | null;
  }): { entry: FeedbackEntry; persisted: PersistOutcome } {
    const t = this.now();
    const entry: FeedbackEntry = {
      id: newId(),
      kind: input.kind,
      title: input.title.slice(0, 400),
      body: input.body.slice(0, MAX_TEXT),
      diagnostics: input.diagnostics ?? null,
      createdAt: t,
      updatedAt: t,
      status: 'draft',
    };
    this.entries.unshift(entry);
    // Trim before writing so the cap is enforced even when quota is ample.
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    const persisted = this.persist();
    return { entry: { ...entry }, persisted };
  }

  update(id: string, patch: Partial<Omit<FeedbackEntry, 'id' | 'createdAt'>>): PersistOutcome {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return { ok: false, problem: 'That entry no longer exists.' };
    this.entries[i] = { ...this.entries[i], ...patch, updatedAt: this.now() };
    return this.persist();
  }

  /** Record that we handed this entry to GitHub's new-issue form. */
  markOpened(id: string): PersistOutcome {
    return this.update(id, { status: 'opened', openedAt: this.now() });
  }

  /** Record that the issue actually exists, optionally with its URL. */
  markFiled(id: string, issueUrl?: string): PersistOutcome {
    const patch: Partial<FeedbackEntry> = { status: 'filed', filedAt: this.now() };
    if (issueUrl && /^https?:\/\//i.test(issueUrl)) patch.issueUrl = issueUrl.slice(0, 400);
    return this.update(id, patch);
  }

  remove(id: string): PersistOutcome {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return { ok: false, problem: 'That entry no longer exists.' };
    return this.persist();
  }

  clear(): PersistOutcome {
    this.entries = [];
    if (!this.storage) return { ok: false, problem: 'Browser storage is unavailable.' };
    try {
      this.storage.removeItem(STORAGE_KEY);
      return { ok: true };
    } catch {
      return { ok: false, problem: 'Browser storage stopped responding.' };
    }
  }

  /**
   * The whole history as pretty JSON — the escape hatch that makes this
   * feature reviewable even for someone who never files a single issue: they
   * can hand this file over and it contains every report with its diagnostics.
   */
  exportJson(): string {
    return JSON.stringify(
      {
        app: 'formicarium',
        schema: FEEDBACK_SCHEMA_VERSION,
        exportedAt: new Date(this.now()).toISOString(),
        count: this.entries.length,
        entries: this.entries,
      },
      null,
      2,
    );
  }

  /** Merge an exported file back in, skipping ids that are already present.
   * Returns how many were added. */
  importJson(text: string): { added: number; persisted: PersistOutcome } {
    const incoming = parseEnvelope(text);
    const known = new Set(this.entries.map((e) => e.id));
    let added = 0;
    for (const entry of incoming) {
      if (known.has(entry.id)) continue;
      this.entries.push(entry);
      known.add(entry.id);
      added++;
    }
    this.sort();
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    return { added, persisted: this.persist() };
  }
}
