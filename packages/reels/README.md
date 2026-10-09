# @kampus/reels

Renders vertical short-form videos (Instagram Reels, TikTok, YouTube Shorts) for **fabrika** and
**tuval** from reel scripts. Nobody appears on camera, and no step needs a person except approving
what gets posted. Each script is one JSON file. A batch renders every changed script to a 1080×1920
H.264 MP4 with a synthesized soundtrack, plus a caption file holding the title, description and
hashtags to paste when posting.

The look follows [brand-imagery.md](../../brand-imagery.md): a phosphor-CRT screen in the dark
register, the scene above ground and coral roots glowing below it. Colors and type come from the
role tokens and fonts of [`@kampus/design`](../design/README.md), never raw hex.

## Use it

```sh
pnpm --filter @kampus/reels check            # judge every script against the medium
pnpm --filter @kampus/reels render           # render every changed reel into out/
pnpm --filter @kampus/reels render -- <id>…  # render only these reels
pnpm --filter @kampus/reels render -- --force --concurrency 2
node packages/reels/src/bin.ts soundtracks && pnpm --filter @kampus/reels studio   # preview in Remotion Studio
```

`render` writes `out/<id>.mp4` and `out/<id>.txt`, and keeps `out/ledger.json` between runs. A reel
whose script and engine source are unchanged since its last render is reported `unchanged` and
skipped; `--force` renders it again. `REELS_BROWSER` points the render at a specific Chrome or
headless shell; otherwise the newest Playwright headless shell under `PLAYWRIGHT_BROWSERS_PATH` is
used, and without one Remotion downloads its own.

## Write a reel

Add `content/<id>.json`. The `id` must match the file name; Studio lists the reel on its next
reload. The schema lives in [`src/reel.ts`](src/reel.ts). A reel opens on a `hook` and closes on an
`outro`. In between it uses any of these scenes:

| Scene | Shows |
|---|---|
| `hook` | Up to 12 words popping in one at a time, with an optional `kicker` above them |
| `terminal` | Commands typed live (`cmd`) and output lines (`out`) |
| `pipeline` | Stages lighting up in order, with an optional `stamp` slammed on at the end |
| `versus` | The usual way struck through, then the way we do it |
| `stat` | A number counting up, with a label |
| `desk` | Tuval-style windows, one per program, all working at once |

In display text, `*word*` paints a word in the accent color. In terminal output,
`[ok]…[/ok]`, `[warn]`, `[bad]`, `[dim]` and `[accent]` color a span.

Durations are never authored. [`src/timeline.ts`](src/timeline.ts) derives them from reading and
typing time. `reels check` refuses a reel that doesn't open on its hook, runs past 59 seconds,
or has a terminal line wider than 40 columns.

## How a batch runs

A batch is a [`@demlik/tea`](https://github.com/kamp-us/demlik) machine
([`src/machine.ts`](src/machine.ts)) on tea's Effect engine. It is pure, and its unit tests replay
it without any I/O:

1. **scoring** writes each reel's soundtrack ([`src/audio.ts`](src/audio.ts), synthesized from a
   seed, with sound effects placed on the same cues the picture animates). The soundtracks go
   first because a Remotion bundle snapshots its public dir.
2. **bundling** bundles the Remotion project ([`src/composition/`](src/composition/)) once.
3. **rendering** fans renders out under `--concurrency`. A failed render is retried on tea's
   backoff curve, up to three attempts. A finished render writes its caption, and the reel is
   stored in the idempotency ledger under the hash of its script plus the engine source.

[`src/studio.ts`](src/studio.ts) performs every side effect, and [`src/pipeline.ts`](src/pipeline.ts)
connects the two. Only the ledger persists between runs, as `out/ledger.json`, through tea's
`fileStore` and an Effect Schema decode ([`src/ledger.ts`](src/ledger.ts)). A run that dies
mid-render reloads as an idle machine with its ledger, and the next batch renders what is missing.

Remotion pins `zod` 4.5.4 exactly, but the workspace holds Remotion's `zod` at the catalog's
4.4.3 (see the overrides in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml)), because a second
`zod` splits `drizzle-orm` in `apps/web`. Studio prints a version warning at startup. Reels pass
no Zod schema to Remotion, so nothing reads `zod` at render time.

Remotion is free for individuals and for companies of up to three people. Larger companies need a
[company license](https://www.remotion.dev/license).
