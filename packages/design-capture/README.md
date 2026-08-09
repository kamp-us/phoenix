# design-capture — phoenix's per-repo golden data

Not a workspace package any more: this directory holds **one file**, phoenix's
golden-screen pointer.

The screenshot/render/golden-diff **machinery** that used to live here moved to
[`@kampus/fabrika-cli/capture`](../fabrika-cli/README.md#the-capture-machinery) so it ships
on fabrika's release train — an adopter repo gets it with fabrika instead of depending on a
phoenix-published package (founder ruling on
[#5061](https://github.com/kamp-us/phoenix/issues/5061), issue
[#5063](https://github.com/kamp-us/phoenix/issues/5063)). The **data** the same ruling keeps
per-repo is what is left here.

## `golden-pointer.json`

The committed pointer of [ADR 0183](../../.decisions/0183-golden-screen-storage-depo-git-pointer.md):
a `surfaces` map from a `<route>[:state]` surface-id to the sha256 of the blessed PNG. The
bytes themselves are **not** in git — they live in depo, content-addressed by that sha256 —
so a blessed golden is a pointer entry here plus an object there.

An empty `surfaces` map is a fact, not a defect: no surface is blessed yet, and every
consumer reads that as "this surface is unblessed" rather than as a failed read.

The path is stable on purpose. Three callers name it directly — `review-design`'s
`blessed-surfaces.sh`, `write-code`'s `step4d-blessed-surfaces.sh`, and the `build-ui`
contract's probe order — so the move above left it exactly where it was.

Bless a surface with the machinery's bin, which writes back to this file:

```bash
node packages/fabrika-cli/src/capture/bin.ts golden-bless --help
```
