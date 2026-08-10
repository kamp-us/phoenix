# @kampus/design-capture

phoenix's **per-repo half** of the golden-screen loop (ADR
[0183](../../.decisions/0183-golden-screen-storage-depo-git-pointer.md)): where this repo's
goldens are stored, which ones are blessed, and the CLI the `review-design` gate drives.

The portable capture / render / golden-diff **machinery** is not here any more — it is
[`@kampus/fabrika-cli/capture`](../fabrika-cli/src/capture/README.md), moved by founder ruling
on [#5061](https://github.com/kamp-us/phoenix/issues/5061) (issue
[#5063](https://github.com/kamp-us/phoenix/issues/5063)) so it ships on fabrika's release
train instead of every adopter repo depending on a phoenix package.

## What stayed, and the line that decides it

The ruling keeps the repo-specific **data** per-repo. In practice the line is sharp: **anything
that names a host or a credential is this repo's.**

- **`golden-pointer.json`** — the committed pointer: a `surfaces` map from a `<route>[:state]`
  surface-id to the sha256 of the blessed PNG. The bytes are never in git; the pointer is. An
  empty map is a fact — no surface is blessed yet — not a failed read. The path is stable on
  purpose: `review-design`'s `blessed-surfaces.sh`, `write-code`'s `step4d-blessed-surfaces.sh`
  and the `build-ui` contract's probe order all name it.
- **`src/golden-store.ts`** — the depo store/fetch boundary. `storeGolden` PUTs blessed bytes
  through `@kampus/depo` and returns `{sha256, url}`; `resolveGoldenBytes` is the seam
  `write-code` and `review-design` resolve a golden through (pointer → depo URL → bytes). Every
  line of it names `depo.kamp.us` or a kampus pasaport key, which is exactly why it is not
  portable. It is also why it could not ship inside fabrika: `@kampus/fabrika-cli` is published,
  and a published artifact may depend only on what a clean registry resolves (ADR
  [0201](../../.decisions/0201-pipeline-tenant-phoenix-first.md) §3) — `@kampus/depo` is private.
  fabrika takes the store as an injected `StoreLeg` instead.
- **`src/bin.ts`** — the CLI the v1 pipeline calls (`capture`, `golden-bless`,
  `render-candidates`, `golden-gallery`, `golden-bless-set`). It composes fabrika's machinery
  with the depo store above. The adopter-facing surface will be fabrika's `ui` verb group
  ([#5061](https://github.com/kamp-us/phoenix/issues/5061)), not this bin.

## Usage

```bash
# capture a PR's changed surfaces over its preview deploy (what review-design drives)
GITHUB_TOKEN=<token> node packages/design-capture/src/bin.ts capture --help

# move the golden pointer to an approved sha, after the founder blesses a candidate
node packages/design-capture/src/bin.ts golden-bless --help
```

The subcommands, their flags and the golden-baseline design are documented once, with the
machinery: [`@kampus/fabrika-cli/capture`'s README](../fabrika-cli/src/capture/README.md).
