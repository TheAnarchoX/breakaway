/**
 * TaskStore's attachments (docs/specs/IDEA-8-images-on-ideas.md): a few small images on a task, kept in
 * this Durable Object's SQL next to the tasks. Only images whose first bytes say PNG, JPEG, WebP, or GIF
 * are kept (never SVG), at most 1 MB each and 4 per task. Deleting a task deletes its images.
 */
import { InputError } from './model.js';

export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_IMAGES_PER_TASK = 4;
const MAX_NAME = 100;
const MAX_ALT = 300;

const startsWith = (bytes, sig, at = 0) => sig.every((b, i) => bytes[at + i] === b);
const ascii = (text) => [...text].map((c) => c.charCodeAt(0));

/** The image type the bytes really are, or null. The file name and the sender's Content-Type are never trusted. */
export function sniffImage(bytes) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}

const clean = (value, max) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .trim()
    .slice(0, max);
const view = (row) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  size: row.size,
  alt: row.alt,
  added: new Date(row.added_at).toISOString(),
});

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const attachmentsMethods = {
  initAttachments() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
        size INTEGER NOT NULL, alt TEXT NOT NULL, added_at INTEGER NOT NULL, data BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attachments_task ON attachments (task, id);
    `);
  },

  attachmentsList(ref) {
    return this.run(() => {
      const task = this.resolve(ref);
      const rows = this.sql
        .exec('SELECT id, name, type, size, alt, added_at FROM attachments WHERE task = ? ORDER BY id', task)
        .toArray();
      return {
        status: 200,
        body: { attachments: rows.map(view), limit: { bytes: MAX_IMAGE_BYTES, count: MAX_IMAGES_PER_TASK } },
      };
    });
  },

  attachmentAdd(ref, bytes, { name, alt } = {}) {
    return this.run(() => {
      const task = this.resolve(ref);
      const data = new Uint8Array(bytes);
      const label = clean(name, MAX_NAME) || 'image';
      if (!data.length) throw new InputError('the image is empty');
      if (data.length > MAX_IMAGE_BYTES)
        throw new InputError(
          `${label} is ${(data.length / 1024 / 1024).toFixed(1)} MB; each image can be up to 1 MB, so shrink it or crop it first`,
        );
      const type = sniffImage(data);
      if (!type) throw new InputError(`${label} isn't a PNG, JPEG, WebP, or GIF image`);
      const count = this.sql.exec('SELECT COUNT(*) AS n FROM attachments WHERE task = ?', task).one().n;
      if (count >= MAX_IMAGES_PER_TASK)
        throw new InputError(`a task can hold ${MAX_IMAGES_PER_TASK} images; delete one first`);
      const row = this.sql
        .exec(
          'INSERT INTO attachments (task, name, type, size, alt, added_at, data) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, name, type, size, alt, added_at',
          task,
          label,
          type,
          data.length,
          clean(alt, MAX_ALT),
          Date.now(),
          data,
        )
        .one();
      return { status: 201, body: { attachment: view(row) } };
    });
  },

  attachmentGet(id) {
    return this.run(() => {
      const row = this.sql.exec('SELECT type, data FROM attachments WHERE id = ?', Number(id)).toArray()[0];
      if (!row) return { status: 404, body: { error: `no image ${id}` } };
      return { status: 200, type: row.type, data: row.data };
    });
  },

  attachmentDelete(id) {
    return this.run(() => {
      const gone = this.sql.exec('DELETE FROM attachments WHERE id = ? RETURNING id', Number(id)).toArray();
      if (!gone.length) return { status: 404, body: { error: `no image ${id}` } };
      return { status: 200, body: { deleted: gone[0].id } };
    });
  },
};
