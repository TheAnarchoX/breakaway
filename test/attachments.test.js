import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const upload = (ref, bytes, { name = 'shot.png', alt = '', type = 'image/png', token = TEST_API_TOKEN } = {}) => {
  const headers = {
    'Content-Type': type,
    'X-Attachment-Name': encodeURIComponent(name),
    'X-Attachment-Alt': encodeURIComponent(alt),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch(`${ORIGIN}/api/tasks/${ref}/attachments`, { method: 'POST', headers, body: bytes });
};

async function newTask(description) {
  const res = await api('tasks', {
    method: 'POST',
    body: { description, project: 'cloud', horizon: 'now', tags: ['agent'] },
  });
  return (await res.json()).tasks[0].wid;
}

describe('attachments', () => {
  it('stores an image, lists it, serves its bytes, and deletes it', async () => {
    const wid = await newTask('Has a picture');
    const made = await upload(wid, PNG, { name: 'my shot.png', alt: 'The join button is cut off' });
    expect(made.status).toBe(201);
    const { attachment } = await made.json();
    expect(attachment).toMatchObject({
      name: 'my shot.png',
      type: 'image/png',
      size: PNG.length,
      alt: 'The join button is cut off',
    });

    const list = await (await api(`tasks/${wid}/attachments`)).json();
    expect(list.attachments).toHaveLength(1);
    expect(list.limit).toEqual({ bytes: 1048576, count: 4 });

    const got = await api(`attachments/${attachment.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('Content-Type')).toBe('image/png');
    expect(got.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([...PNG]);

    expect((await api(`attachments/${attachment.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(`attachments/${attachment.id}`)).status).toBe(404);
    expect((await (await api(`tasks/${wid}/attachments`)).json()).attachments).toEqual([]);
  });

  it('trusts the first bytes, not the name or the Content-Type', async () => {
    const wid = await newTask('Sniffing');
    const webp = await upload(wid, WEBP, { name: 'a.png', type: 'image/png' });
    expect((await webp.json()).attachment.type).toBe('image/webp');
    const svg = await upload(wid, SVG, { name: 'x.png', type: 'image/png' });
    expect(svg.status).toBe(400);
    expect((await svg.json()).error).toMatch(/isn't a PNG, JPEG, WebP, or GIF/);
    expect((await upload(wid, new Uint8Array())).status).toBe(400);
  });

  it('refuses an image over 1 MB, and a fifth image', async () => {
    const wid = await newTask('Limits');
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(PNG);
    const over = await upload(wid, big, { name: 'huge.png' });
    expect(over.status).toBe(400);
    expect((await over.json()).error).toMatch(/huge\.png is 1\.0 MB; each image can be up to 1 MB/);
    const exact = new Uint8Array(1024 * 1024);
    exact.set(PNG);
    expect((await upload(wid, exact)).status).toBe(201);
    for (let i = 0; i < 3; i += 1) expect((await upload(wid, PNG)).status).toBe(201);
    const fifth = await upload(wid, PNG);
    expect(fifth.status).toBe(400);
    expect((await fifth.json()).error).toMatch(/4 images/);
  });

  it("needs the board's auth and a real task", async () => {
    const wid = await newTask('Auth');
    expect((await upload(wid, PNG, { token: null })).status).toBe(401);
    const made = await (await upload(wid, PNG)).json();
    expect((await api(`attachments/${made.attachment.id}`, { token: null })).status).toBe(401);
    expect((await api(`attachments/${made.attachment.id}`, { token: 'wrong' })).status).toBe(401);
    expect((await upload('NOPE-999', PNG)).status).toBe(404);
    expect((await api('attachments/999999')).status).toBe(404);
  });
});
