/**
 * In-game feedback panel.
 *
 * Formicarium is a static page with no backend, so this cannot POST a report
 * anywhere. What it does instead:
 *
 *   1. Captures the report and the simulation state it happened in, locally.
 *   2. Opens GitHub's new-issue form with everything prefilled.
 *   3. Keeps its own copy either way, exportable as JSON.
 *
 * Step 3 is what makes step 2 safe to fail. Popup blockers, a GitHub login
 * redirect, a closed tab or simply changing your mind all leave the report
 * intact in the history list, ready to retry — and the export means the
 * feedback is reviewable even for someone who never files an issue at all.
 *
 * Styling lives in src/style.css under "--- Feedback panel ---".
 */

import type { ISimulation } from '../sim/facade';
import { ISSUES_URL } from '../appInfo';
import { captureDiagnostics, type Diagnostics } from './diagnostics';
import { composeIssue, composeMarkdown, KIND_LABEL } from './feedbackCompose';
import { FeedbackStore, type FeedbackEntry, type FeedbackKind, type PersistOutcome } from './feedbackStore';

const MAX_TITLE = 120;
const MAX_BODY = 4000;

const KINDS: { kind: FeedbackKind; icon: string; label: string; hint: string }[] = [
  { kind: 'feature', icon: '💡', label: 'Idea', hint: "Something you'd like the simulator to do." },
  { kind: 'bug', icon: '🐞', label: 'Bug', hint: 'Something is broken or looks wrong.' },
  { kind: 'balance', icon: '⚖️', label: 'Balance', hint: 'The colonies feel too easy, too brutal, or too slow.' },
  { kind: 'praise', icon: '🌟', label: 'Praise', hint: 'Something you liked. Genuinely useful to know.' },
  { kind: 'other', icon: '💬', label: 'Other', hint: 'Anything else.' },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function relativeTime(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Open a URL in a new tab and report honestly whether it worked.
 *
 * The obvious spelling — `window.open(url, '_blank', 'noopener,noreferrer')` —
 * is a trap here: passing `noopener` makes the call return `null` **by spec**,
 * exactly like a blocked popup does. With that version every successful open
 * looked like a failure, so the user was told their browser had blocked the
 * tab while GitHub was loading in front of them.
 *
 * So the opener is severed after the fact instead. Assigning `opener` can
 * throw once the new window has navigated cross-origin, which is harmless —
 * by then it no longer has a usable handle back to us anyway.
 */
function defaultOpenUrl(url: string): Window | null {
  const win = window.open(url, '_blank');
  if (win) {
    try {
      win.opener = null;
    } catch {
      /* already cross-origin; nothing to sever */
    }
  }
  return win;
}

export interface FeedbackPanelOptions {
  /** Injectable for tests; defaults to the real window.open. */
  openUrl?: (url: string) => Window | null;
}

export class FeedbackPanel {
  readonly element: HTMLElement;

  private store = new FeedbackStore();
  private kind: FeedbackKind = 'feature';
  private attachDiagnostics = true;
  private pendingDiagnostics: Diagnostics | null = null;
  private openUrl: (url: string) => Window | null;

  private card!: HTMLElement;
  private kindRow!: HTMLElement;
  private kindHint!: HTMLElement;
  private titleInput!: HTMLInputElement;
  private bodyInput!: HTMLTextAreaElement;
  private bodyCount!: HTMLElement;
  private diagToggle!: HTMLInputElement;
  private diagPreview!: HTMLElement;
  private diagDetails!: HTMLDetailsElement;
  private statusEl!: HTMLElement;
  private historyEl!: HTMLElement;
  private submitBtn!: HTMLButtonElement;
  private lastFocused: Element | null = null;

  constructor(
    private sim: ISimulation,
    opts: FeedbackPanelOptions = {},
  ) {
    this.openUrl = opts.openUrl ?? defaultOpenUrl;
    this.element = this.build();
  }

  // -------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------

  private build(): HTMLElement {
    const backdrop = el('div', 'fb-backdrop hidden');
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) this.close();
    });

    const card = el('div', 'fb-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Send feedback');
    this.card = card;
    backdrop.appendChild(card);

    // --- Header
    const head = el('div', 'fb-head');
    const kicker = el('div', 'fb-kicker');
    kicker.innerHTML = '<b>Feedback</b> · shape what gets built next';
    const close = el('button', 'fb-close', '✕');
    close.type = 'button';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close feedback');
    close.addEventListener('click', () => this.close());
    head.append(kicker, close);
    card.appendChild(head);

    const body = el('div', 'fb-body');
    card.appendChild(body);

    // --- Kind picker
    body.appendChild(el('label', 'fb-label', 'What kind of feedback?'));
    this.kindRow = el('div', 'fb-kinds');
    this.kindRow.setAttribute('role', 'radiogroup');
    this.kindRow.setAttribute('aria-label', 'Feedback type');
    for (const k of KINDS) {
      const btn = el('button', 'fb-kind');
      btn.type = 'button';
      btn.dataset.kind = k.kind;
      btn.setAttribute('role', 'radio');
      btn.innerHTML = `<span class="fb-kind-icon">${k.icon}</span><span>${k.label}</span>`;
      btn.addEventListener('click', () => this.setKind(k.kind));
      this.kindRow.appendChild(btn);
    }
    body.appendChild(this.kindRow);
    this.kindHint = el('div', 'fb-hint');
    body.appendChild(this.kindHint);

    // --- Title
    const titleLabel = el('label', 'fb-label', 'One-line summary');
    titleLabel.htmlFor = 'fb-title';
    body.appendChild(titleLabel);
    this.titleInput = el('input', 'fb-input');
    this.titleInput.id = 'fb-title';
    this.titleInput.type = 'text';
    this.titleInput.maxLength = MAX_TITLE;
    this.titleInput.placeholder = 'Ants ignore food that is right next to them';
    this.titleInput.addEventListener('input', () => this.refreshSubmitState());
    body.appendChild(this.titleInput);

    // --- Body
    const bodyLabel = el('label', 'fb-label', 'Details');
    bodyLabel.htmlFor = 'fb-body';
    body.appendChild(bodyLabel);
    this.bodyInput = el('textarea', 'fb-textarea');
    this.bodyInput.id = 'fb-body';
    this.bodyInput.rows = 6;
    this.bodyInput.maxLength = MAX_BODY;
    this.bodyInput.placeholder =
      'What happened, what you expected instead, and anything you did just before it.\n\nFor an idea: what you want to be able to do, and why.';
    this.bodyInput.addEventListener('input', () => {
      this.refreshSubmitState();
      this.refreshCount();
    });
    body.appendChild(this.bodyInput);
    this.bodyCount = el('div', 'fb-count');
    body.appendChild(this.bodyCount);

    // --- Diagnostics
    const diagWrap = el('div', 'fb-diag');
    const diagHead = el('label', 'fb-check');
    this.diagToggle = el('input');
    this.diagToggle.type = 'checkbox';
    this.diagToggle.checked = true;
    this.diagToggle.addEventListener('change', () => {
      this.attachDiagnostics = this.diagToggle.checked;
      this.refreshDiagnostics();
    });
    const diagText = el('span');
    diagText.innerHTML =
      'Attach what the simulator is doing right now <span class="fb-sub">— the seed, tier, population and frame rate. This is what makes a report reproducible.</span>';
    diagHead.append(this.diagToggle, diagText);
    diagWrap.appendChild(diagHead);

    this.diagDetails = el('details', 'fb-diag-details');
    const summary = el('summary', 'fb-diag-summary', 'Show exactly what will be attached');
    this.diagDetails.appendChild(summary);
    const warn = el('div', 'fb-diag-warn');
    warn.textContent = 'This becomes a public GitHub issue. Nothing personal is collected, but do look before you send.';
    this.diagDetails.appendChild(warn);
    this.diagPreview = el('pre', 'fb-diag-pre');
    this.diagDetails.appendChild(this.diagPreview);
    diagWrap.appendChild(this.diagDetails);
    body.appendChild(diagWrap);

    // --- Status line
    this.statusEl = el('div', 'fb-status');
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');
    body.appendChild(this.statusEl);

    // --- Actions
    const actions = el('div', 'fb-actions');
    this.submitBtn = el('button', 'fb-btn fb-btn-primary', 'Open a GitHub issue');
    this.submitBtn.type = 'button';
    this.submitBtn.addEventListener('click', () => this.submit());

    const copyBtn = el('button', 'fb-btn', 'Copy as Markdown');
    copyBtn.type = 'button';
    copyBtn.title = 'Copy the whole report — including full diagnostics — to paste anywhere';
    copyBtn.addEventListener('click', () => this.copyCurrent());

    const browse = el('a', 'fb-btn fb-btn-quiet', 'Browse existing');
    browse.href = ISSUES_URL;
    browse.target = '_blank';
    browse.rel = 'noopener noreferrer';
    browse.title = 'See what has already been asked for — and add a 👍 instead of a duplicate';

    actions.append(this.submitBtn, copyBtn, browse);
    body.appendChild(actions);

    // --- History
    const histHead = el('div', 'fb-hist-head');
    histHead.appendChild(el('span', 'fb-label', 'Your reports'));
    const exportBtn = el('button', 'fb-link', 'Export all as JSON');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', () => this.exportAll());
    histHead.appendChild(exportBtn);
    body.appendChild(histHead);

    this.historyEl = el('div', 'fb-hist');
    body.appendChild(this.historyEl);

    this.setKind('feature');
    this.refreshCount();
    return backdrop;
  }

  // -------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------

  private setKind(kind: FeedbackKind) {
    this.kind = kind;
    for (const btn of Array.from(this.kindRow.querySelectorAll<HTMLButtonElement>('.fb-kind'))) {
      const active = btn.dataset.kind === kind;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-checked', String(active));
    }
    this.kindHint.textContent = KINDS.find((k) => k.kind === kind)?.hint ?? '';
    this.refreshSubmitState();
  }

  private refreshCount() {
    const n = this.bodyInput.value.length;
    this.bodyCount.textContent = `${n} / ${MAX_BODY}`;
    this.bodyCount.classList.toggle('near-limit', n > MAX_BODY * 0.9);
  }

  private refreshSubmitState() {
    const ok = this.titleInput.value.trim().length >= 4;
    this.submitBtn.disabled = !ok;
    this.submitBtn.title = ok ? '' : 'Add a one-line summary first';
  }

  /**
   * Re-capture diagnostics and repaint the preview.
   *
   * Snapshotted when the panel opens rather than when Submit is pressed: the
   * simulation keeps running underneath, and the state the user is describing
   * is the state at the moment they reached for the feedback button, not
   * whatever it has drifted to two minutes later while they typed.
   */
  private refreshDiagnostics() {
    if (!this.attachDiagnostics) {
      this.diagDetails.classList.add('hidden');
      this.diagPreview.textContent = '';
      return;
    }
    this.diagDetails.classList.remove('hidden');
    try {
      this.pendingDiagnostics = captureDiagnostics(this.sim);
      this.diagPreview.textContent = JSON.stringify(this.pendingDiagnostics, null, 2);
    } catch {
      // Never block a report on diagnostics.
      this.pendingDiagnostics = null;
      this.diagPreview.textContent = 'Diagnostics could not be captured; your report will be sent without them.';
    }
  }

  private setStatus(message: string, tone: 'info' | 'ok' | 'warn' = 'info') {
    this.statusEl.textContent = message;
    this.statusEl.className = `fb-status fb-status-${tone}`;
  }

  private notePersist(outcome: PersistOutcome) {
    if (outcome.ok) return;
    this.setStatus(
      `${outcome.problem ?? 'Could not save locally.'} Your report is still here for this session — copy it as Markdown if you want to keep it.`,
      'warn',
    );
  }

  // -------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------

  private currentDraft() {
    return {
      kind: this.kind,
      title: this.titleInput.value.trim(),
      body: this.bodyInput.value.trim(),
      diagnostics: (this.attachDiagnostics ? this.pendingDiagnostics : null) as Record<string, unknown> | null,
    };
  }

  private submit() {
    const draft = this.currentDraft();
    if (draft.title.length < 4) return;

    const { entry, persisted } = this.store.add(draft);
    const composed = composeIssue(entry);

    const win = this.openUrl(composed.url);
    if (win) {
      this.store.markOpened(entry.id);
      const caveat = composed.diagnosticsDropped
        ? ' Diagnostics were too big for the link — use “Copy as Markdown” and paste them in if they matter.'
        : '';
      this.setStatus(`Opened a prefilled issue on GitHub. Press Submit there to file it.${caveat}`, 'ok');
      this.titleInput.value = '';
      this.bodyInput.value = '';
      this.refreshCount();
      this.refreshSubmitState();
    } else {
      // Popup blocked. The report is already saved, so offer the link rather
      // than losing the click.
      this.setStatus('Your browser blocked the new tab. Your report is saved below — use its “Open on GitHub” link.', 'warn');
    }
    this.notePersist(persisted);
    this.renderHistory();
  }

  private async copy(text: string, okMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.setStatus(okMessage, 'ok');
      return;
    } catch {
      /* fall through to the manual path */
    }
    // Clipboard API needs a secure context and permission; when it is refused,
    // put the text on screen selected so Ctrl+C still works.
    const area = el('textarea', 'fb-fallback-text');
    area.value = text;
    area.readOnly = true;
    this.statusEl.textContent = 'Copy blocked by the browser — select and copy this:';
    this.statusEl.className = 'fb-status fb-status-warn';
    this.statusEl.appendChild(area);
    area.focus();
    area.select();
  }

  private copyCurrent() {
    const draft = this.currentDraft();
    if (!draft.title && !draft.body) {
      this.setStatus('Write something first.', 'warn');
      return;
    }
    void this.copy(composeMarkdown(draft), 'Report copied. Paste it into an issue, an email, or a message.');
  }

  private exportAll() {
    if (this.store.size === 0) {
      this.setStatus('No reports saved yet.', 'warn');
      return;
    }
    void this.copy(this.store.exportJson(), `Exported ${this.store.size} report(s) to the clipboard as JSON.`);
  }

  private renderHistory() {
    const entries = this.store.list();
    this.historyEl.textContent = '';

    if (entries.length === 0) {
      this.historyEl.appendChild(el('div', 'fb-empty', 'Nothing yet. Reports you write are kept here on this device.'));
      return;
    }

    if (!this.store.persistent) {
      this.historyEl.appendChild(
        el('div', 'fb-empty', 'Storage is unavailable in this browser, so this list is only kept until you close the tab.'),
      );
    }

    for (const entry of entries.slice(0, 25)) {
      this.historyEl.appendChild(this.renderHistoryRow(entry));
    }
  }

  private renderHistoryRow(entry: FeedbackEntry): HTMLElement {
    const row = el('div', 'fb-hist-row');

    const main = el('div', 'fb-hist-main');
    const title = el('div', 'fb-hist-title', entry.title || '(no summary)');
    const meta = el('div', 'fb-hist-meta');
    const statusWord = entry.status === 'filed' ? 'filed' : entry.status === 'opened' ? 'opened on GitHub' : 'not sent';
    meta.textContent = `${KIND_LABEL[entry.kind]} · ${relativeTime(entry.createdAt)} · ${statusWord}`;
    main.append(title, meta);
    row.appendChild(main);

    const tools = el('div', 'fb-hist-tools');

    if (entry.issueUrl) {
      const link = el('a', 'fb-link', 'View issue');
      link.href = entry.issueUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      tools.appendChild(link);
    } else {
      const open = el('button', 'fb-link', entry.status === 'draft' ? 'Open on GitHub' : 'Open again');
      open.type = 'button';
      open.addEventListener('click', () => {
        const composed = composeIssue(entry);
        const win = this.openUrl(composed.url);
        if (win) {
          this.store.markOpened(entry.id);
          this.setStatus('Opened on GitHub. Press Submit there to file it.', 'ok');
          this.renderHistory();
        } else {
          this.setStatus('Your browser is blocking new tabs. Allow popups for this site, or copy the report instead.', 'warn');
        }
      });
      tools.appendChild(open);

      const done = el('button', 'fb-link', 'Mark filed');
      done.type = 'button';
      done.title = 'I submitted this on GitHub';
      done.addEventListener('click', () => {
        this.notePersist(this.store.markFiled(entry.id));
        this.renderHistory();
      });
      tools.appendChild(done);
    }

    const copyOne = el('button', 'fb-link', 'Copy');
    copyOne.type = 'button';
    copyOne.addEventListener('click', () => void this.copy(composeMarkdown(entry), 'Report copied.'));
    tools.appendChild(copyOne);

    const del = el('button', 'fb-link fb-link-danger', 'Delete');
    del.type = 'button';
    del.addEventListener('click', () => {
      this.notePersist(this.store.remove(entry.id));
      this.renderHistory();
    });
    tools.appendChild(del);

    row.appendChild(tools);
    return row;
  }

  // -------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------

  open(): void {
    this.lastFocused = document.activeElement;
    this.element.classList.remove('hidden');
    this.refreshDiagnostics();
    this.renderHistory();
    this.setStatus('');
    this.refreshSubmitState();
    window.addEventListener('keydown', this.onKeyDown, true);
    // Defer focus past the class change so the field is actually focusable.
    requestAnimationFrame(() => this.titleInput.focus());
  }

  close(): void {
    this.element.classList.add('hidden');
    window.removeEventListener('keydown', this.onKeyDown, true);
    if (this.lastFocused instanceof HTMLElement) this.lastFocused.focus();
  }

  get isOpen(): boolean {
    return !this.element.classList.contains('hidden');
  }

  /**
   * Esc closes; Tab is trapped inside the dialog.
   *
   * Captured at the window so the game's own keyboard shortcuts (space to
   * pause, digits for speed) don't fire while someone is typing a report about
   * them — `stopPropagation` here is the whole point.
   */
  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key === 'Tab') {
      const focusable = this.card.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    // Everything else: keep it away from the world's key handlers.
    e.stopPropagation();
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.element.remove();
  }
}
