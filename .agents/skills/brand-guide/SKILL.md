---
name: brand-guide
description: breakaway's brand guide and checklist. Use for any change people will see or read (the board's strings, views, components, styles, icons, the manifest, docs, the README, the landing page, launch posts), and before handing such a change back.
---

# breakaway's brand

The source is [`brand/README.md`](../../../brand/README.md). Read the parts your change touches before you start; this skill only says how to use it. Where they differ, the guide wins.

## Before you write or design

- **Words:** read Voice, Writing it, and Words breakaway uses. breakaway is always lowercase, the board talks to "you", agents go by their name or "agent", and everyone else is "people". Buttons are verbs, errors say what failed and what to do, and success is a word or two.
- **Claims:** anything breakaway says about itself must be on the list of Claims that must stay true, or ship in the same pull request as the feature it describes. Say "free", "fair source", or "the source is public", and "open source" only of a release that has turned Apache 2.0. The story uses only the three approved facts, in the past tense.
- **Look:** read Color, Type, and Shape and motion. Use the tokens in `brand/tokens.css` (the board's stylesheet reads the same names), never hex values. One red thing leads each view; red text only at display size, `--accent` below it. Carbon is the default theme and chalk must work too.
- **Never** the words on the never list, exclamation marks, emoji, "powered by", another product's logo next to breakaway's, mascots, gradients, or a real repository's private work in a screenshot or fixture.

## Before you hand it back

1. Go through the guide's **Checklist** and fix anything that fails.
2. Run `pnpm brand` (the lint for the name, the never list, exclamation marks, and "open source"; a line opts out with `brand-lint-ignore <rule>` in a comment) and `pnpm test`: `test/brand.test.js` checks every text color's contrast in both themes and that the guide's tables match the tokens. A token change updates the guide's tables in the same pull request.
3. For a change to the board, look at it in `pnpm dev` in carbon and chalk, narrow and wide, with the keyboard, and with reduced motion on.
4. In the pull request, add a **Brand** section: the checklist with each item ticked or marked not applicable, and what you looked at.

## Changing the brand

The logo, palette, and type are built by `brand/tools/build.mjs` from `brand/tokens.css`; never edit the generated SVGs by hand. A change to the voice, the word list, the claims, or the palette changes `brand/README.md` first, in its own pull request the owner reviews, and this skill only if how to work changes.
