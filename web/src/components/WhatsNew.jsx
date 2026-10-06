import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { CircleArrowUp, ExternalLink, X } from 'lucide-preact';
import { plural } from '../lib/model.js';
import { Markdown } from '../lib/richtext.jsx';
import { health } from '../lib/store.js';
import { notesFor, showFor } from '../lib/whats-new.js';
import { Dialog } from './ui.jsx';

/**
 * What's new (WEB-80): once the board runs a newer release than this browser last saw, a stable opens a dialog with
 * its notes, and a pre-release on the main channel, which comes with every merge, shows a small note in a corner
 * that opens them. The notes come from whats-new.json in the board's own files, so nothing is fetched from anywhere
 * else. The release this browser saw is kept in it, so the first visit shows nothing.
 */

const SEEN = 'tasks.whatsNewSeen';
const ext = { target: '_blank', rel: 'noopener noreferrer' };

/** The notes for the release the board runs, or null when its files have none. Settings opens them again. */
export const whatsNew = signal(/** @type {ReturnType<typeof notesFor>} */ (null));
/** What shows now: the dialog, the corner note, or nothing. */
const showing = signal(/** @type {'dialog' | 'note' | null} */ (null));

export const openWhatsNew = () => {
  if (whatsNew.value) showing.value = 'dialog';
};

function readSeen() {
  try {
    return localStorage.getItem(SEEN);
  } catch {
    return null;
  }
}

function saveSeen(release) {
  try {
    localStorage.setItem(SEEN, release);
  } catch {
    /* storage blocked: it shows again next time */
  }
}

let checked = null;

/** Reads whats-new.json once per release the server reports, and decides whether to show it. */
async function check(release) {
  if (checked === release) return;
  checked = release;
  let file = null;
  try {
    const res = await fetch('/whats-new.json', { cache: 'no-cache', headers: { Accept: 'application/json' } });
    // A build without the file (a local one, or a release from before it) answers 404, or the web app's page.
    if (res.ok) file = await res.json().catch(() => null);
  } catch {
    checked = null; // offline: look again with the next health check
    return;
  }
  whatsNew.value = notesFor(release, file);
  const show = showFor({ running: release, seen: readSeen(), file });
  saveSeen(release);
  if (show) showing.value = show;
}

function Title({ notes }) {
  return notes.channel === 'stable' ? `What’s new in breakaway ${notes.version}` : `Updated to ${notes.version}`;
}

function NotesLink({ notes }) {
  if (!notes.url) return null;
  return (
    <a class="btn btn-quiet" href={notes.url} {...ext}>
      Read the release notes
      <ExternalLink size={15} aria-hidden="true" />
      <span class="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

export function WhatsNew() {
  const release = health.value?.release;
  useEffect(() => {
    if (release) check(release);
  }, [release]);
  const notes = whatsNew.value;
  const close = () => {
    showing.value = null;
  };
  return (
    <>
      <Dialog open={Boolean(notes) && showing.value === 'dialog'} onClose={close} labelledBy="wn-title">
        {notes && (
          <div class="sheet whats-new">
            <div class="wn-head">
              <h2 id="wn-title">
                <Title notes={notes} />
              </h2>
              <p class="muted small">
                {plural(notes.changes, 'change')}
                {notes.from ? ` since ${notes.from}` : ''}
              </p>
            </div>
            <div class="wn-notes">
              <Markdown text={notes.notes} />
            </div>
            <div class="sheet-actions">
              <NotesLink notes={notes} />
              <button type="button" class="btn btn-primary" onClick={close} autofocus>
                Done
              </button>
            </div>
          </div>
        )}
      </Dialog>
      {notes && showing.value === 'note' && (
        <aside class="wn-note" aria-labelledby="wn-note-title">
          <CircleArrowUp size={18} aria-hidden="true" class="wn-note-icon" />
          <div class="wn-note-text">
            <strong id="wn-note-title">
              <Title notes={notes} />
            </strong>
            <span class="muted small">{plural(notes.changes, 'change')}</span>
          </div>
          <button type="button" class="btn btn-outline btn-sm" onClick={openWhatsNew}>
            See what’s new
          </button>
          <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Dismiss" onClick={close}>
            <X size={16} aria-hidden="true" />
          </button>
        </aside>
      )}
    </>
  );
}
