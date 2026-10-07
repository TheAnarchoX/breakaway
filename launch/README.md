# Launch

Drafts for the launch post and thread, the X profile, and the small kit that makes their images and video, and the README's. The owner posts, from breakaway's own account or their own; agents never do.

| File | What |
| --- | --- |
| [`2.0.0.md`](2.0.0.md) | The plan for 2.0.0's launch, Architect: the story, the claims, each piece and what it says, the order, and what's held back |
| [`posts.md`](posts.md) | The post and thread, in posting order, with the media and alt text for each |
| [`profile.md`](profile.md) | The profile of [@leavethepackdev](https://x.com/leavethepackdev), breakaway's account on X: its name, bio, website, and images |
| `media/` | The images (PNG, 2160 px, square) and the video (MP4, 1080 px, 16 s) the posts use, and the profile's images in `media/profile/` |
| `tools/` | The scripts that make the media |

## Making the media

The kit draws every image and frame in Chromium from the brand's own files (`brand/tokens.css`, `brand/logo/`, and the Archivo and Chivo Mono fonts), so what you see in a browser is what ships. You need Node, `ffmpeg`, and Chromium (`CHROMIUM=<path>` if it isn't at `/usr/sbin/chromium`).

```sh
cd launch/tools
npm install
node cards.mjs                 # every card
node cards.mjs 02-one-claim    # one card
node video.mjs                 # the launch video
node video.mjs 2-0-0           # 2.0.0's video, Architect
node profile.mjs               # the X profile's photo and header
node readme.mjs                # the README's hero and diagrams, in carbon and chalk, and the social card
```

The README's screenshots are of the real board, run locally with made-up work, never a real install's. Start the launch board, `node board.mjs`: breakaway's own Worker under `wrangler dev` on 127.0.0.1:8787, with throwaway secrets, a made-up GitHub, and a made-up Cloudflare account for Architect (`board/`, never deployed). It prints its token. Then `pnpm dev` for the web app, and:

```sh
BREAKAWAY_URL=http://127.0.0.1:8787 BREAKAWAY_TOKEN=<its token> BREAKAWAY_HOME=$(mktemp -d) ./seed.sh
BREAKAWAY_TOKEN=<its token> node screens.mjs
node readme.mjs social-architect   # after screens.mjs: it shows the plan page from it
```

Each run of `board.mjs` starts the board empty, so the work IDs come out the same. `seed.sh` against a plain local board (`wrangler dev` with a config from `node install.mjs --local`) still seeds the tasks; it skips Architect, which needs the launch board.

Take them within two minutes of seeding, while the seeded agent's output still reads as **Working now**.

| Script | Makes |
| --- | --- |
| `kit.mjs` | The shared parts: tokens and fonts as one page, a still renderer, a frame-by-frame video renderer that pipes to `ffmpeg` |
| `cards.mjs` | A card is an entry in `CARDS`: a kicker, a display headline, a body. Output is `media/<name>.png` |
| `video.mjs` | Each video is one HTML scene whose `render(t)` draws the frame for time `t`, so it renders the same every time: `launch` and `2-0-0` |
| `readme.mjs` | The README's hero, How it works, How it's built, the peloton, Claude Code, and Architect, each in carbon and chalk: `docs/media/<name>-dark.png` and `-light.png`. Architect's social card, `site/public/social-architect.png`, for its page on the site. And the social card, the hero at 1280 by 640 in carbon: `site/public/social.png`, which the site's pages name as `og:image`. The same file is the repository's social preview: upload it in the repository's Settings, under General, Social preview |
| `profile.mjs` | The X profile's images: `media/profile/avatar.png`, the app icon full bleed at 800 px, and `media/profile/header.png`, 1500 by 500 |
| `board.mjs`, `board/` | The launch board: breakaway's Worker run locally, with a made-up GitHub (`board/github.js`) and a made-up Cloudflare account (`board/provider.js`), and a `/__launch` route that moves them along |
| `seed.sh` | Fills a local board with made-up work (`acme/widgets`) for the screenshots, a chased feature and its peloton included, and on the launch board, Architect with `architect.mjs` |
| `architect.mjs` | Architect's made-up world, through the board's own API: staging and production, a plan applied through the runner's path and one waiting for you, production's envelope, and an incident |
| `screens.mjs` | The screenshots of that board: the board, a task's live output, the inbox, a phone, a chased feature, and Architect's views (Infrastructure, an environment, a plan on a phone, an envelope, an incident) |

Keep new media to the [guide](../brand/README.md): carbon, flat color, one red thing, the lean, made-up tasks, no mascots. Add alt text to `posts.md` for every file.
