import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronLeft, ChevronRight, ImagePlus, X } from 'lucide-preact';
import { api, enc, uploadImage } from '../lib/api.js';
import { MAX_IMAGES, isImage, prepareImage } from '../lib/images.js';
import { ref } from '../lib/model.js';
import { confirmDialog, toast } from '../lib/store.js';
import { Dialog } from './ui.jsx';
import { taskLock } from './Who.jsx';

const src = (image) => `/api/attachments/${image.id}`;

/** Prepares and uploads files to a task; returns the images that went up. Says why on a toast for the rest. */
export async function attachFiles(taskRef, files) {
  const added = [];
  for (const file of files) {
    try {
      const { blob, name } = await prepareImage(file);
      added.push(await uploadImage(taskRef, blob, { name }));
    } catch (error) {
      toast(error.message, 'error');
    }
  }
  return added;
}

/** The images the clipboard holds, if any. */
export const pastedImages = (event) => [...(event.clipboardData?.files ?? [])].filter(isImage);

/**
 * A picker button that also takes dropped and pasted images anywhere inside `children`'s wrapper.
 * @param {Record<string, any>} props
 */
export function ImagePicker({ onFiles, disabled, full }) {
  const input = useRef(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        class="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          onFiles([...e.currentTarget.files]);
          e.currentTarget.value = '';
        }}
      />
      <button type="button" class="btn btn-outline btn-sm" disabled={disabled} onClick={() => input.current.click()}>
        <ImagePlus size={16} aria-hidden="true" />
        Add image
      </button>
      <span class="field-hint">
        {full
          ? `Up to ${MAX_IMAGES} images.`
          : 'Pick, drop, or paste. PNG, JPEG, WebP or GIF, up to 1 MB (big screenshots are shrunk). Crop out anything private.'}
      </span>
    </>
  );
}

/** @param {Record<string, any>} props */
function Viewer({ images, index, onIndex, onClose }) {
  const image = images[index];
  const many = images.length > 1;
  const step = (by) => onIndex((index + by + images.length) % images.length);
  useEffect(() => {
    if (!many) return undefined;
    const key = (e) => {
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  });
  return (
    <Dialog open onClose={onClose} labelledBy="viewer-title" className="dialog-viewer">
      <div class="viewer">
        <div class="viewer-head">
          <h2 id="viewer-title">
            {image.name}
            {many && (
              <span class="muted">
                {' '}
                · {index + 1} of {images.length}
              </span>
            )}
          </h2>
          <button type="button" class="btn btn-quiet btn-icon" aria-label="Close" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div class="viewer-stage">
          {many && (
            <button type="button" class="btn btn-quiet btn-icon" aria-label="Previous image" onClick={() => step(-1)}>
              <ChevronLeft size={22} aria-hidden="true" />
            </button>
          )}
          <img src={src(image)} alt={image.alt || image.name} />
          {many && (
            <button type="button" class="btn btn-quiet btn-icon" aria-label="Next image" onClick={() => step(1)}>
              <ChevronRight size={22} aria-hidden="true" />
            </button>
          )}
        </div>
        {image.alt && <p class="viewer-caption">{image.alt}</p>}
      </div>
    </Dialog>
  );
}

/**
 * Thumbnails of a task's images. `onRemove` gets the image (without one, they're only viewed); `viewer` state lives
 * here so focus returns to the thumbnail.
 * @param {Record<string, any>} props
 */
export function Thumbnails({ images, onRemove }) {
  const [open, setOpen] = useState(null);
  if (!images.length) return null;
  return (
    <>
      <ul class="thumbs">
        {images.map((image, i) => (
          <li key={image.id ?? image.url}>
            <button type="button" class="thumb" aria-label={`View ${image.name}`} onClick={() => setOpen(i)}>
              <img src={image.url ?? src(image)} alt={image.alt || image.name} />
            </button>
            {onRemove && (
              <button
                type="button"
                class="thumb-remove"
                aria-label={`Remove ${image.name}`}
                onClick={() => onRemove(image)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {open !== null && images[open]?.id && (
        <Viewer
          images={images}
          index={Math.min(open, images.length - 1)}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/**
 * The task sidebar's Images section.
 * @param {Record<string, any>} props
 */
export function AttachmentsSection({ task }) {
  const id = ref(task);
  const [images, setImages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  // Someone who can't change the task sees its images, and adds or removes none (WEB-137).
  const lock = taskLock(task);

  useEffect(() => {
    let live = true;
    setImages([]);
    api(`tasks/${enc(id)}/attachments`)
      .then((d) => {
        if (live) setImages(d.attachments);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);

  const add = async (files) => {
    if (lock) return;
    const room = MAX_IMAGES - images.length;
    if (!files.length) return;
    if (files.length > room)
      toast(
        room
          ? `Only ${room} more fit; a task holds ${MAX_IMAGES} images.`
          : `A task holds ${MAX_IMAGES} images. Remove one first.`,
        'error',
      );
    setBusy(true);
    const added = await attachFiles(id, files.slice(0, Math.max(room, 0)));
    setImages((list) => [...list, ...added]);
    setBusy(false);
    if (added.length) toast(added.length === 1 ? 'Image added.' : `${added.length} images added.`, 'success');
  };
  const remove = async (image) => {
    if (
      !(await confirmDialog({
        title: `Remove ${image.name}?`,
        body: 'It can’t be brought back.',
        confirmLabel: 'Remove',
        tone: 'danger',
      }))
    )
      return;
    try {
      await api(`attachments/${image.id}`, { method: 'DELETE' });
      setImages((list) => list.filter((i) => i.id !== image.id));
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  return (
    <section
      class={`panel-section attach ${over ? 'attach-over' : ''}`}
      aria-labelledby={`images-${task.uuid}`}
      onDragOver={(e) => {
        if (!lock && e.dataTransfer?.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        add([...e.dataTransfer.files].filter(isImage));
      }}
      onPaste={(e) => {
        const files = pastedImages(e);
        if (files.length) {
          e.preventDefault();
          add(files);
        }
      }}
    >
      <h3 id={`images-${task.uuid}`}>Images</h3>
      <Thumbnails images={images} onRemove={lock ? null : remove} />
      {lock ? (
        !images.length && <p class="muted small">No images.</p>
      ) : (
        <div class="attach-actions">
          <ImagePicker
            onFiles={add}
            disabled={busy || images.length >= MAX_IMAGES}
            full={images.length >= MAX_IMAGES}
          />
        </div>
      )}
    </section>
  );
}
