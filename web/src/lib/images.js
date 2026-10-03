// Getting images ready to attach: shrink big screenshots in the browser so they fit the 1 MB limit
// (docs/specs/IDEA-8-images-on-ideas.md).

export const MAX_BYTES = 1024 * 1024;
export const MAX_IMAGES = 4;
const MAX_SIDE = 1600;
const ACCEPTED = /^image\/(png|jpeg|webp|gif)$/u;

export const isImage = (file) => ACCEPTED.test(file.type);

const size = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function encode(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * The file itself when it already fits, otherwise a copy scaled to 1600 px on its longest side (JPEG when
 * PNG stays too big). GIFs are never re-encoded, since that would stop the animation. Throws a sentence
 * saying which image and what to do.
 */
export async function prepareImage(file) {
  const name = file.name || 'pasted image';
  if (!isImage(file)) throw new Error(`${name} isn’t a PNG, JPEG, WebP, or GIF image.`);
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${name} can’t be read as an image.`);
  }
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (file.size <= MAX_BYTES && scale === 1) return { blob: file, name };
    if (file.type === 'image/gif') {
      if (file.size <= MAX_BYTES) return { blob: file, name };
      throw new Error(`${name} is ${size(file.size)}; each image can be up to 1 MB. Crop it or pick a smaller GIF.`);
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob = await encode(canvas, file.type, 0.85);
    if (!blob || blob.size > MAX_BYTES) blob = await encode(canvas, 'image/jpeg', 0.8);
    if (!blob || blob.size > MAX_BYTES)
      throw new Error(`${name} is still over 1 MB after shrinking. Crop it to the part that matters.`);
    return { blob, name: blob.type === file.type ? name : `${name.replace(/\.\w+$/u, '')}.jpg` };
  } finally {
    bitmap.close();
  }
}
