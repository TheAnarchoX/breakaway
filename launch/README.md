# Launch

Drafts for the launch post and thread, and the small kit that makes their images and video, and the README's. The owner posts; agents never do.

| File | What |
| --- | --- |
| [`posts.md`](posts.md) | The post and thread, in posting order, with the media and alt text for each |
| `media/` | The images (PNG, 2160 px, square) and the video (MP4, 1080 px, 16 s) the posts use |
| `tools/` | The scripts that make the media |

## Making the media

The kit draws every image and frame in Chromium from the brand's own files (`brand/tokens.css`, `brand/logo/`, and the Archivo and Chivo Mono fonts), so what you see in a browser is what ships. You need Node, `ffmpeg`, and Chromium (`CHROMIUM=<path>` if it isn't at `/usr/sbin/chromium`).

```sh
cd launch/tools
npm install
node cards.mjs                 # every card
node cards.mjs 02-one-claim    # one card
node video.mjs                 # the video
node readme.mjs                # the README's hero and diagrams, in carbon and chalk
```

The README's screenshots are of the real board, run locally with made-up work, never a real install's. Start it (`wrangler dev` with a local config from `node install.mjs --local`, and `pnpm dev` for the web app), then:

```sh
BREAKAWAY_URL=http://127.0.0.1:8787 BREAKAWAY_TOKEN=<its token> BREAKAWAY_HOME=$(mktemp -d) ./seed.sh
BREAKAWAY_TOKEN=<its token> node screens.mjs
```

Take them within two minutes of seeding, while the seeded agent's output still reads as **Working now**.

| Script | Makes |
| --- | --- |
| `kit.mjs` | The shared parts: tokens and fonts as one page, a still renderer, a frame-by-frame video renderer that pipes to `ffmpeg` |
| `cards.mjs` | A card is an entry in `CARDS`: a kicker, a display headline, a body. Output is `media/<name>.png` |
| `video.mjs` | The video is one HTML scene whose `render(t)` draws the frame for time `t`, so it renders the same every time |
| `readme.mjs` | The README's hero, How it works, and How it's built, each in carbon and chalk: `docs/media/<name>-dark.png` and `-light.png` |
| `seed.sh` | Fills a local board with made-up work (`acme/widgets`) for the screenshots |
| `screens.mjs` | The README's screenshots of that board: the board, a task's live output, the inbox, and a phone |

Keep new media to the [guide](../brand/README.md): carbon, flat color, one red thing, the lean, made-up tasks, no mascots. Add alt text to `posts.md` for every file.
