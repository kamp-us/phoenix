# fabrika config key groups

How `.fabrika.jsonc` is read: one load, one parse, one module per key, one registry line.

Lives in [`packages/fabrika-cli/src/config/`](../packages/fabrika-cli/src/config/). Repo-specific
values that used to be TypeScript literals become keys here, so an adopting repo is a data file
rather than a branch in fabrika's source (ADR 0273, epic
[#5631](https://github.com/kamp-us/phoenix/issues/5631)).

## The shape

| File | What it holds |
|---|---|
| `document.ts` | `CONFIG_PATH`, the comment stripper, and `readDocument` — the only place the bytes are parsed |
| `key-group.ts` | `KeyGroup<A>`, the four-arm `Resolution<A>`, `resolveKey`, and `register` |
| `keys/<key>.ts` | One key group: its key name, its shipped default, its decoder |
| `registry.ts` | One `register(...)` line per key group |
| `load.ts` | `loadConfig(source)` → a document every key resolves against, or a refusal |
| `working-root.ts` | `loadRepoConfig(cwd)` — the working-tree opener, for a verb running against the checkout it stands in |
| `containment.ts` | The triage-facet containment invariant, checked over declared data |

Whoever opens the file says which of three things it found — `Absent`, `Text`, `Unreadable` — and
hands that to `loadConfig`. A key module never sees a file, only the parsed record.

## The four arms

Every key resolves to exactly one, and they stay apart in the type:

- **`Default`** — no file, or no key. The key's shipped default.
- **`Declared`** — the repo declared it and it decoded.
- **`Malformed`** — the value is present and refused **whole**, naming what was rejected. Never a
  skipped entry: a typo'd entry silently dropped is a declaration the operator believes is
  configured and is not.
- **`Unknown`** — the file exists and could not be read. Callers refuse. Never a default, never an
  empty set.

`Default` and `Unknown` are the pair the surface turns on. Collapsing them is how a settings file
silently disables a gate.

## Adding a key

1. Write `keys/<your-key>.ts`: export the key name, a `decode`, and a `KeyGroup<A>` with a
   `shippedDefault`.
2. Add one `register(yourKey)` line to `registry.ts`.

Nothing else is touched. That is the point — concurrent slices each add a key without serializing
on one growing reader.

## Two rules a new key must hold

**A shipped default is never an empty gate list.** An empty list of governed roots or of required
labels reads as "nothing is governed" / "nothing is required" and turns the gate off. Pick the
value that reproduces today's behaviour, and make an explicitly-declared empty list `Malformed`
where empty would disable something. The widen-only keys are the exception and say so in their own
docblocks: for `capClearAuthors`, `docLeakExempt` and `workflowValidators`, empty **is** the strict
answer.

**A key whose value could disable or widen a guard is refused at load.** `refuseLoad` on a
`KeyGroup` refuses the whole load, before any key's value is used. Two keys use it, for the same
reason in two shapes: `governedRoots`, so a config whose roots do not cover `.fabrika.jsonc` cannot
un-govern itself; and `triageFacets`, so a config declaring a facet value the facet does not own
cannot reconcile an issue into a shape nobody asked for (#4285). A convention could not hold either
one, because the config is what the convention would be read from — and a check written at a call
site is a check the next verb forgets.

## Reading a key at the working tree

A verb running against a base ref opens the bytes itself (`git show`) and hands `loadConfig` a
`Text`. A verb running against the checkout it stands in calls `loadRepoConfig(cwd)`, which finds the
repo root **above** `cwd` first: a config read only at the top level would resolve to the shipped
defaults for every run from a subdirectory, which is a silent widening nothing reports. Take the
`cwd` as an option off `command.ts` (`cwd: process.cwd()`) rather than reading it in the verb, so a
unit test can point the load at a scripted filesystem.
