# IDEA-8 · Images on ideas

Task: IDEA-8 on the board · Status: draft

## Problem

Some ideas are best shown: an annotated screenshot, or a visual bug that is clearer to look at than to describe. An idea today is text only, so the agent shaping it never sees what the owner saw.

## Feasibility (checked)

It works with cloud agents, with no new service:

- **Agents can see images.** Claude Code's `Read` tool shows PNG and JPG files to the model.
- **Agents can reach the board.** Cloud sessions call the board through the proxy that injects the board's credentials, and the CLI already does this for every command. Image bytes can come the same way.
- **The routine payload stays text.** The fire endpoint takes text only, so images never travel in it. The agent fetches them from the board after it starts, by task ID.
- **Storage fits the board as it is.** The board is one Durable Object with SQLite (no R2 binding). A row holds at most 2 MB, so images are capped well below that and stored in chunks or one row each, in a new `attachments` table. No new binding, route, or Durable Object class, so merging deploys it with no owner step.

## Fit

The board holds project work and no personal data, and this keeps that. Images are the owner's own; the same rule as every task applies (no personal data, no secrets in an image). It touches no settled decision.

## Design

- **Attach.** The New idea form (and the task sidebar) accepts images by picker, drag and drop, or paste. `node scripts/tasks.mjs idea "…" --image shot.png` and `attach <ID> <file>` do the same. Only the owner attaches; agents may not.
- **Limits.** PNG, JPEG, WebP, or GIF, checked by their first bytes, not the file name. Up to 1 MB each after the web form shrinks larger screenshots in the browser (longest side 1600 px), up to 4 per task. SVG is refused (script risk). Over the limit, the form says which image and what to do.
- **Storage.** `attachments(id, task uuid, name, type, size, alt, added_at, data BLOB)` in the Durable Object. Deleting a task deletes its images. Each image takes an optional caption, which is its alt text and what the agent reads first.
- **Serving.** `GET /api/tasks/<ID>/attachments` lists them; `GET /api/attachments/<id>` returns the bytes with the stored type, `Content-Disposition: attachment`-safe headers, `X-Content-Type-Options: nosniff`, and the board's usual auth. Never public.
- **Board UI.** Thumbnails under the description, each with its caption as alt text and a remove button (with a confirm). Clicking or pressing Enter or Space on a thumbnail opens the viewer, described next. Keyboard and screen-reader usable; the board's existing dark and light themes.
- **Image viewer.** It works like the image views people already know, built on the board's existing `Dialog` (native `<dialog>`, `showModal()`), so focus is trapped and returned to the thumbnail on close:
  - A darkened backdrop over the board; the image sits centred in a contained panel, shown at its natural size but never larger than about 90% of the viewport width and height (`object-fit: contain`), never true fullscreen. Small images are not scaled up.
  - The file name is the title above the image (the dialog's accessible name), with the caption beneath the image when there is one.
  - A close button (a cross, 44 px target, labelled "Close") at the top right of the panel. Escape, and a click or tap on the backdrop outside the panel, also close it. A click on the image itself does nothing.
  - With more than one image on the task, previous and next buttons and the left and right arrow keys move between them, and the title shows "2 of 3"; with one image, no arrows.
  - Reduced motion: no open or close animation. Narrow screens: the panel uses the width minus a small margin.
- **The agent.** `node scripts/tasks.mjs attachments <ID>` lists them and `attachments <ID> --save <dir>` downloads them; then `Read` shows each. The "Shaping an idea" and "Refining a task" parts of the agent prompt say: look at the images first, describe what they show in the spec instead of relying on them, and never copy them into the repository unless the owner asks. The payload gets a line `Attachments: <n>` so the agent knows to look; the prompt tells it to treat that as context, like the note.
- **In the spec.** Images stay on the board. A spec that needs a picture describes it in words and, if the owner agrees, commits a cropped copy under `docs/specs/`.
- **Edge states.** No images: nothing changes. Board offline or fetch fails: the agent notes it on the task and shapes from the text, saying so. An image that can't be decoded: the upload is refused.

## Privacy

Screenshots of an app can show a real person's account or someone else's content; the form reminds the owner to crop those out, and the agent never repeats such details in a spec, task, or pull request.

## Out of scope

- Images in comments, agent uploads, video, or other file types.
- Attachments on the routine payload itself.
- Public sharing of an image.

## Done when

- Tasks below are built and merged.
- The owner pastes the updated agent prompt into the routine.

Tasks: CLD-92 (store and API), CLD-93 (board and CLI), CLD-94 (payload and prompt), CLD-95 (owner pastes the prompt).
