# Add a wire format to the registry

Steps to register one new wire format — from an empty editor to a format `wire emit`, `wire read`
and `wire check` all answer for, the conformance suite green, and the index doc re-rendered to
match. Every command and output below was followed against this tree at the commit this page was
written at.

Two pages hold what this one leaves out: [`../docs/wire-formats.md`](../docs/wire-formats.md) says
what a wire format *is* and maps the ones already registered, and
[ADR 0241](../../../.decisions/0241-wire-formats-owned-by-schema-modules.md) says why a schema
module owns the bytes. Neither is repeated here.

Run the CLI from source — `node packages/fabrika-cli/src/bin.ts`. An installed copy answers from its
own checkout's registry, which does not know your row until it ships.

## 1. Write the schema module

New file: `packages/fabrika-cli/src/wire/<key>.ts`, where `<key>` is the `--format` selector,
kebab-case. Copy [`came-from.ts`](../../../packages/fabrika-cli/src/wire/came-from.ts) as the
template — one self-contained file carrying every piece listed below, from the branded value type to
both byte-level adapters — and swap in your grammar. The module owns your format's bytes and nothing
else:

- the typed core: a branded value type with one field per thing the block carries
- `read(artifact)` — total over three answers: `Found` / `Absent` / `Malformed`. The type is
  [`WireRead`](../../../packages/fabrika-cli/src/wire/format.ts); "present but drifted" must land on
  `Malformed`, never read back as a clean absence
- `emit(...)`, composing conforming bytes
- the two byte-level adapters the registry row binds: `parseFields` → `emitFromFields`, and
  `readToLines`

A law the shared suite cannot state about your grammar gets its own `<key>.unit.test.ts` beside the
module — see [`routed-elsewhere.unit.test.ts`](../../../packages/fabrika-cli/src/wire/routed-elsewhere.unit.test.ts)
for the precedent. Everything else rides on the row's fixtures, next step.

## 2. Register the row

One row in `registeredFormats` in
[`registry.ts`](../../../packages/fabrika-cli/src/wire/registry.ts) — a format exists by being
registered there and nowhere else. The row carries the key, a one-line purpose, the owner-module
path, who produces the bytes and who consumes them, the two adapters, fixtures and brands.

The compiler holds you to the parts prose would not: `fixtures` (one `roundTrip`, at least one
authored-shape `found`, one `absent`, at least one drift) is required by `WireFormat`, and `brands`
is built by `brandWitnesses` over your value type, so a branded field you forget stops the build.
Then prove the row compiles and conforms:

```bash
cd packages/fabrika-cli
pnpm typecheck
pnpm vitest run src/wire/conformance.unit.test.ts
```

The suite iterates the whole registry, so your row is driven through the shared laws by landing in
the array. Back at the repo root, the listing names it:

```bash
node packages/fabrika-cli/src/bin.ts wire formats | grep '<key>'
```

## 3. Render the index doc

```bash
node packages/fabrika-cli/src/bin.ts wire index --write
```

This re-renders the generated table inside `claude-plugins/fabrika/docs/wire-formats.md` — never
type that table by hand. The command still exits 4 here, because one finding is yours to fix by
hand: a narrative paragraph under a level-3 heading carrying your key in backticks (`### \`<key>\``),
beside the other sections. That paragraph is the half no registry row holds — what the agreement is
*for* — and the check refuses a registered format without one. Never edit between the generated
region's begin/end markers; the generator reverts that and CI reds on it.

The same verb without `--write` is the check, and done means it agrees:

```bash
node packages/fabrika-cli/src/bin.ts wire index
# index	agrees	<registered>	<documented>
```

## 4. Prove the format reads back

Round-trip through the verbs — fields your `parseFields` accepts on stdin, your block out, your
fields back:

```bash
printf 'id: gadget-ab12cd\n' \
  | node packages/fabrika-cli/src/bin.ts wire emit --format <key> \
  | node packages/fabrika-cli/src/bin.ts wire read --format <key>
# found	<key>	1
```

And against an artifact nobody emitted — the shape a human actually writes:

```bash
node packages/fabrika-cli/src/bin.ts wire check --format <key> < the-artifact.md
# conforms	<key>	1
```

The round trip proves your reader and writer agree with each other; the `found` fixture you
registered in step 2 is what proves they agree with the world. Done when typecheck, the conformance
suite and `wire index` are all green and both commands above answer for your key.
