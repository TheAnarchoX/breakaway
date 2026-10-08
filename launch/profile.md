# The X profile

breakaway's account on X is [@leavethepackdev](https://x.com/leavethepackdev). This is what goes in its profile: copy each field as it is, and upload the images. The owner sets it up and posts; agents never do. Who posts from it, and how, is in the [brand guide](../brand/README.md#where-breakaway-posts).

| Field | Value |
| --- | --- |
| Name | `breakaway` |
| Bio | `A task board for you and your coding agents: they claim the work, you merge it. Runs on your own Cloudflare account. Free for people, not for profit.` |
| Location | Leave it empty |
| Website | `leavethepack.dev` |
| Profile photo | [`media/profile/avatar.png`](media/profile/avatar.png) |
| Header photo | [`media/profile/header.png`](media/profile/header.png) |
| Pinned post | The launch post, [1 in `posts.md`](posts.md#1-the-launch-post), once it's posted |

The bio is 148 characters (X allows 160) and says only what's on the guide's [claims that must stay true](../brand/README.md#claims-that-must-stay-true). The name stays lowercase: X shows it as typed.

## The images

`node profile.mjs` in `tools/` makes both (see [Making the media](README.md#making-the-media)).

- **Profile photo**: 800 by 800 px, the app icon full bleed: the mark on carbon. X crops it to a circle, so the mark sits inside the circle with room around it.
  **Alt text:** The breakaway mark on carbon: a white slab and a narrow red slab with a gap between them, both leaning forward.
- **Header photo**: 1500 by 500 px, carbon. "Leave the pack." with "pack." in red, then "A task board for you and your coding agents." and `leavethepack.dev · npx breakaway`. The words sit on the right, because X lays the profile photo over the header's lower left, and phones crop its top and bottom.
  **Alt text:** Leave the pack. in big white italic type with "pack." in red, on carbon. Below it: A task board for you and your coding agents. And: leavethepack.dev, npx breakaway.

After uploading, look at the profile on a phone and on a computer: the photo shouldn't cover any words, and the headline shouldn't be cut off.
