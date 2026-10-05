// The board's JSON API (tools/tasks/src/worker.js), with the cookie from /login.

export class ApiError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let onSignedOut = () => {};
export function whenSignedOut(fn) {
  onSignedOut = fn;
}

/** A refusal as a sentence: a capital first, a full stop last. */
export const sentence = (text) => {
  const s = String(text).trim();
  const capital = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/u.test(capital) ? capital : `${capital}.`;
};

/**
 * @param {string} path
 * @param {{ method?: string, body?: any }} [options]
 */
export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Couldn’t reach the board. Check your connection and try again.', 0);
  }
  if (res.status === 401) {
    onSignedOut();
    throw new ApiError('Sign in again to keep going.', 401);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(
      data.error ? sentence(data.error) : 'The board couldn’t do that. Try again in a minute.',
      res.status,
      data,
    );
  return data;
}

export const enc = encodeURIComponent;

/** Uploads one image (the raw bytes) to a task; the name and caption travel URL-encoded in headers. */
export const uploadImage = (taskRef, blob, options) => upload(`tasks/${enc(taskRef)}/attachments`, blob, options);

/** Uploads one image to a kickoff (WEB-35), the owner's from the signed-in board, until its IDEA takes them. */
export const uploadKickoffImage = (id, blob, options) => upload(`kickoffs/${enc(id)}/images`, blob, options);

async function upload(path, blob, { name, alt = '' }) {
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        'X-Attachment-Name': enc(name),
        'X-Attachment-Alt': enc(alt),
      },
      body: blob,
    });
  } catch {
    throw new ApiError('Couldn’t reach the board. Check your connection and try again.', 0);
  }
  if (res.status === 401) {
    onSignedOut();
    throw new ApiError('Sign in again to keep going.', 401);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(
      data.error ? sentence(data.error) : 'The board couldn’t do that. Try again in a minute.',
      res.status,
      data,
    );
  return data.attachment;
}
