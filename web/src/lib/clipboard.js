import { toast } from './store.js';

/** Copies `text` and says so; if the browser refuses, shows the text so it can be copied by hand. */
export async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied.`, 'success');
  } catch {
    toast(`Couldn’t copy. Select it and copy it yourself: ${text}`, 'error');
  }
}
