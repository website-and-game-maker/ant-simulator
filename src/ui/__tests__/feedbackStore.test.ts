import { describe, expect, it } from 'vitest';
import { FeedbackStore, MAX_ENTRIES, type StorageLike } from '../feedbackStore';

/** In-memory Storage with an optional byte budget, so quota behaviour can be
 * driven deterministically instead of hoping a real browser runs out. */
class FakeStorage implements StorageLike {
  map = new Map<string, string>();
  constructor(private budget = Infinity) {}
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (v.length > this.budget) {
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const draft = (title: string, diagnostics: Record<string, unknown> | null = null) => ({
  kind: 'feature' as const,
  title,
  body: 'body text',
  diagnostics,
});

describe('FeedbackStore', () => {
  it('persists entries and reloads them from storage', () => {
    const storage = new FakeStorage();
    const a = new FeedbackStore({ storage });
    expect(a.add(draft('first')).persisted.ok).toBe(true);
    a.add(draft('second'));

    const b = new FeedbackStore({ storage });
    expect(b.list().map((e) => e.title)).toEqual(['second', 'first']);
  });

  it('keeps working in memory when storage is entirely unavailable', () => {
    const store = new FeedbackStore({ storage: null });
    const { entry, persisted } = store.add(draft('no storage here'));
    expect(persisted.ok).toBe(false);
    expect(store.persistent).toBe(false);
    // The crucial part: the report the user just wrote is still retrievable.
    expect(store.get(entry.id)?.title).toBe('no storage here');
  });

  it('survives a storage that throws on read', () => {
    const hostile: StorageLike = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {},
      removeItem() {},
    };
    const store = new FeedbackStore({ storage: hostile });
    expect(store.list()).toEqual([]);
    expect(store.persistent).toBe(false);
  });

  it('drops already-filed entries first when the quota is hit', () => {
    const storage = new FakeStorage();
    const store = new FeedbackStore({ storage });
    const filed = store.add(draft('already filed')).entry;
    store.markFiled(filed.id);
    const keep = store.add(draft('unsent draft')).entry;

    // Squeeze the budget to just under the current payload, forcing a prune.
    const current = storage.getItem('formicarium-feedback-v2')!.length;
    (storage as unknown as { budget: number }).budget = current - 1;

    const outcome = store.add(draft('newest'));
    expect(outcome.persisted.ok).toBe(true);
    const titles = store.list().map((e) => e.title);
    expect(titles).toContain('newest');
    expect(titles).toContain(keep.title);
    expect(titles).not.toContain('already filed');
  });

  it('never discards the newest entry, even under extreme pressure', () => {
    const storage = new FakeStorage(120);
    const store = new FeedbackStore({ storage });
    store.add(draft('older one'));
    const { entry } = store.add(draft('the one being written'));
    expect(store.get(entry.id)).not.toBeNull();
    expect(store.list()[0].title).toBe('the one being written');
  });

  it('strips diagnostics off older entries before dropping them wholesale', () => {
    const storage = new FakeStorage();
    const store = new FeedbackStore({ storage });
    const bulky = { blob: 'x'.repeat(2000) };
    const old = store.add(draft('old with diagnostics', bulky)).entry;

    const current = storage.getItem('formicarium-feedback-v2')!.length;
    (storage as unknown as { budget: number }).budget = current - 500;

    store.add(draft('new one'));
    const reloaded = store.get(old.id);
    // Still present, just lighter.
    expect(reloaded).not.toBeNull();
    expect(reloaded?.diagnostics).toBeNull();
  });

  it('enforces the entry cap', () => {
    const store = new FeedbackStore({ storage: new FakeStorage() });
    for (let i = 0; i < MAX_ENTRIES + 25; i++) store.add(draft(`entry ${i}`));
    expect(store.size).toBe(MAX_ENTRIES);
    expect(store.list()[0].title).toBe(`entry ${MAX_ENTRIES + 24}`);
  });

  it('migrates a v1 bare-array payload forward', () => {
    const storage = new FakeStorage();
    storage.setItem(
      'formicarium-feedback-v1',
      JSON.stringify([
        { id: 'fb_old', kind: 'bug', title: 'from v1', body: 'legacy', createdAt: 1000, status: 'draft' },
      ]),
    );
    const store = new FeedbackStore({ storage });
    expect(store.list().map((e) => e.title)).toEqual(['from v1']);
    // Rewritten under the new key, old key retired.
    expect(storage.getItem('formicarium-feedback-v1')).toBeNull();
    expect(storage.getItem('formicarium-feedback-v2')).toContain('from v1');
  });

  it('skips malformed records without losing the valid ones', () => {
    const storage = new FakeStorage();
    storage.setItem(
      'formicarium-feedback-v2',
      JSON.stringify({
        version: 2,
        entries: [
          null,
          'nonsense',
          { id: '', title: 'no id' },
          { id: 'fb_ok', title: 'survivor', body: 'x', createdAt: 5, kind: 'feature', status: 'draft' },
          { id: 'fb_weird', title: 'odd kind', body: 'x', createdAt: 6, kind: 'not-a-kind', status: '???' },
        ],
      }),
    );
    const store = new FeedbackStore({ storage });
    const titles = store.list().map((e) => e.title);
    expect(titles).toContain('survivor');
    expect(titles).toContain('odd kind');
    expect(titles).not.toContain('no id');
    // Unrecognised enum values fall back rather than persisting as-is.
    expect(store.list().find((e) => e.title === 'odd kind')?.kind).toBe('other');
  });

  it('recovers from corrupt JSON rather than throwing', () => {
    const storage = new FakeStorage();
    storage.setItem('formicarium-feedback-v2', '{not json at all');
    const store = new FeedbackStore({ storage });
    expect(store.list()).toEqual([]);
    expect(store.add(draft('fresh start')).persisted.ok).toBe(true);
  });

  it('refuses a non-http issue URL', () => {
    const store = new FeedbackStore({ storage: new FakeStorage() });
    const { entry } = store.add(draft('x'));
    store.markFiled(entry.id, 'javascript:alert(1)');
    expect(store.get(entry.id)?.issueUrl).toBeUndefined();
    store.markFiled(entry.id, 'https://github.com/o/r/issues/1');
    expect(store.get(entry.id)?.issueUrl).toBe('https://github.com/o/r/issues/1');
  });

  it('round-trips through export and import, skipping duplicates', () => {
    const a = new FeedbackStore({ storage: new FakeStorage() });
    a.add(draft('one'));
    a.add(draft('two'));
    const json = a.exportJson();

    const b = new FeedbackStore({ storage: new FakeStorage() });
    expect(b.importJson(json).added).toBe(2);
    expect(b.importJson(json).added).toBe(0);
    expect(b.list().map((e) => e.title).sort()).toEqual(['one', 'two']);
  });
});
