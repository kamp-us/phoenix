# Tuval spells: the command framework

**Reference.** What the pieces of Tuval's command framework are, field by field, so a builder
writing a new spell can look one up without reading the whole slice. The *why* (the thirteen
[#7617](https://github.com/kamp-us/phoenix/issues/7617) rulings) is ADR
[0348](../.decisions/0348-tuval-command-framework-spell-registry-versioned-protocol.md); this page
carries no argument for the design.

Everything below is read off the code under [`apps/tuval/src/commands/`](../apps/tuval/src/commands)
and [`apps/tuval/src/protocol/`](../apps/tuval/src/protocol). A companion unit test,
[`apps/tuval/src/commands/pattern-doc-paths.unit.test.ts`](../apps/tuval/src/commands/pattern-doc-paths.unit.test.ts),
asserts that every path this page cites is on disk, so the page cannot drift into naming a file that
moved.

## The pieces, by file

| File | What is in it |
|---|---|
| [`spell.ts`](../apps/tuval/src/commands/spell.ts) | `Spell`, `defineSpell`, `SpellPath`, `Scope`, `renderPath`, the `WindowId` / `WorkspaceId` / `ClientId` brands |
| [`registry.ts`](../apps/tuval/src/commands/registry.ts) | `buildRegistry`, `SpellRegistry`, `SpellRow`, `SpellNode`, `RegistryTable`, `lookupRow`, `describeSpell` |
| [`spell-set.ts`](../apps/tuval/src/commands/spell-set.ts) | `SpellSet`: the table and the key bindings compiled against it, in one cell |
| [`scope.ts`](../apps/tuval/src/commands/scope.ts) | `WindowIndex`, `WindowPlacement`, `Client`, `resolveScope` |
| [`executor.ts`](../apps/tuval/src/commands/executor.ts) | `SpellExecutor`: one `SpellCall` in, one `SpellReply` out |
| [`errors.ts`](../apps/tuval/src/commands/errors.ts) | `DuplicateSpellPath`, `SpellNotDescribable`, `SpellNotFound`, `NoSuchWindow`, `UnknownSpell`, `BadArgs`, `BadResult`, `SpellFailed` |
| [`index.ts`](../apps/tuval/src/commands/index.ts) | a partial barrel: `bindings/`, `errors`, `executor`, `parse/`, `registry`, `scope` and `spell`, but not `core/` or `bridge/`, which are imported from their own directories |
| [`parse/tokenize.ts`](../apps/tuval/src/commands/parse/tokenize.ts) | the command line's lexer |
| [`parse/reading.ts`](../apps/tuval/src/commands/parse/reading.ts) | the single walk `parse` and `complete` share |
| [`parse/parse.ts`](../apps/tuval/src/commands/parse/parse.ts) | `parse`, `ParseResult`, `SpellCallDraft` |
| [`parse/complete.ts`](../apps/tuval/src/commands/parse/complete.ts) | `complete`, `Candidate`, the two ranking rules |
| [`parse/spell-index.ts`](../apps/tuval/src/commands/parse/spell-index.ts) | `buildSpellIndex`, `readParams`, `ParamSpec`, `describeExpected` |
| [`parse/did-you-mean.ts`](../apps/tuval/src/commands/parse/did-you-mean.ts) | the one suggestion a refusal carries |
| [`bindings/compile.ts`](../apps/tuval/src/commands/bindings/compile.ts) | `compileBindings`, `Binding`, `KeyBindings` |
| [`bindings/errors.ts`](../apps/tuval/src/commands/bindings/errors.ts) | `BindingError`, `renderBindingErrors` |
| [`bindings/file.ts`](../apps/tuval/src/commands/bindings/file.ts) | `describeFile`: how a config module is named in an error |
| [`core/help.ts`](../apps/tuval/src/commands/core/help.ts) | the `help` spell and its row rendering |
| [`core/spell.ts`](../apps/tuval/src/commands/core/spell.ts) | `spell list` and `spell describe` |
| [`core/process.ts`](../apps/tuval/src/commands/core/process.ts) | `process spawn`, `process send`, `process read` |
| [`core/index.ts`](../apps/tuval/src/commands/core/index.ts) | `helpSpells`, the three discovery spells as a list |
| [`bridge/SpellBridge.ts`](../apps/tuval/src/commands/bridge/SpellBridge.ts) | the program-blind `list` / `call` surface an agent's SDK tool wraps |
| [`bridge/errors.ts`](../apps/tuval/src/commands/bridge/errors.ts) | `SpellNotAllowed` |
| [`protocol/messages.ts`](../apps/tuval/src/protocol/messages.ts) | the four messages, the two unions, `PROTOCOL_VERSION` |
| [`protocol/codec.ts`](../apps/tuval/src/protocol/codec.ts) | the four total encode / decode functions |
| [`protocol/ids.ts`](../apps/tuval/src/protocol/ids.ts) | the wire's branded ids and scalars |
| [`protocol/desk.ts`](../apps/tuval/src/protocol/desk.ts) | `Desk`, `Workspace`, `Window`, the layout tree |
| [`protocol/process-row.ts`](../apps/tuval/src/protocol/process-row.ts) | `ProcessRow` as a snapshot carries it |
| [`protocol/registry-description.ts`](../apps/tuval/src/protocol/registry-description.ts) | `SpellDescription`, `RegistryDescription`, `CapabilityRequest` |
| [`protocol/patch.ts`](../apps/tuval/src/protocol/patch.ts) | `applyPatch` |
| [`protocol/recency.ts`](../apps/tuval/src/protocol/recency.ts) | `nextRecency`, `focusWindow`: minting the `recency` stamp |
| [`protocol/issue.ts`](../apps/tuval/src/protocol/issue.ts) | `firstSchemaIssue`, `describeSchemaError` |
| [`protocol/json.ts`](../apps/tuval/src/protocol/json.ts) | the `try`/`catch` JSON boundary, both directions |
| [`protocol/errors.ts`](../apps/tuval/src/protocol/errors.ts) | `ProtocolRefused`, `PatchRefused` |
| [`registry/program.ts`](../apps/tuval/src/registry/program.ts) | the program row, including its optional `spells` |

## A spell

`defineSpell` in [`spell.ts`](../apps/tuval/src/commands/spell.ts) is the identity function. Its
whole job is inference: an `execute` that returns a Promise, or a `params` that is not an Effect
`Schema`, is a compile error at the definition site.

| Field | Type | Notes |
|---|---|---|
| `path` | `readonly [string, ...string[]]` | non-empty in the type, so an empty path is unrepresentable; lowercase English segments (`["window", "close"]`) |
| `describe` | `string` | one user-facing sentence, written once and rendered by every surface |
| `params` | `Schema.Top` | an Effect `Schema`; the executor decodes the call's `args` against it |
| `result` | `Schema.Top` | the executor encodes the return value against it |
| `execute` | `(args, scope) => Effect` | failures and service needs ride the spell's own type |
| `capabilities` | `ReadonlyArray<CapabilityRequest>` | **declared and checked by nothing**; see below |

`renderPath` is how a path reads in a refusal or a description: `window.close`.

`AnySpell` is the spell with its parameter, result, error and requirement types erased. The registry
stores that, because one table holds spells of every shape.

### Capabilities are inert

The `capabilities` list reuses the kernel's `CapabilityRequest` record from
[`registry/program.ts`](../apps/tuval/src/registry/program.ts). Nothing grants it, nothing checks
it, nothing denies it. It is not a security boundary. The only thing standing between a calling
program and the registry today is the bridge's allowlist, and that list is whatever the caller
passed to `SpellBridge.layer({allow})`, not a check the kernel makes.

## A program declares its spells

A program row's optional `spells` field
([`registry/program.ts`](../apps/tuval/src/registry/program.ts)) is a list of `AnySpell`. The
kernel's own `Registry` never reads it; only the spell registry does. Each entry is registered under
`[programId, ...spell.path]`, so a program's spells are namespaced by its id and cannot collide with
the core list by accident.

`registry/program.ts` imports `AnySpell` with `import type`, so nothing crosses at runtime in that
direction and the runtime dependency stays one way: `commands/` reaches into `registry/`, never the
reverse.

## The registry

`buildRegistry({core, programs})` in
[`registry.ts`](../apps/tuval/src/commands/registry.ts) is registration. It is a pure Effect over
the core spell list and the program rows, and it produces a `RegistryTable`:

- `root`, a trie of `SpellNode`s keyed by path segment; a node carries a `SpellRow` when a spell is
  registered at exactly its path.
- `rows`, the flat list `list` and `describe` read.

Registration is the one place a spell can be refused, and there are two refusals. Two spells
claiming one path fail with `DuplicateSpellPath`. A spell whose `params` has no JSON Schema form
fails with `SpellNotDescribable`: `Schema.toJsonSchemaDocument` throws at the pin, and rendering
happens here, at registration, so a spell nobody can describe never enters the table and describing
a registered one cannot throw. Both name the path and the source (`describeSource` renders "the core
spell list" or `program "<id>"`).

`SpellRegistry` is a `Context.Service` over one `Ref` holding the table:

| Member | Answers |
|---|---|
| `lookup(path)` | the `SpellRow`, or `SpellNotFound` |
| `list` | every `SpellRow` |
| `describe` | every row as a `SpellDescription` |
| `swap(table)` | replaces the whole table |

Every read is a single `Ref.get` and `swap` is a single `Ref.set`, so a config reload replaces every
program's spells at once and no reader ever walks a half-replaced table.

`lookupRow(table, path)` is the trie walk itself, exported so the registry, the binding compiler
and `SpellSet` take one walk rather than three.

Three layers build the service. `SpellRegistry.layer(table)` holds a table of its own and
`SpellRegistry.scripted(spells)` builds one from a bare core list, which is the test seam; the
third is `SpellSet.layer`, below, which is what boot uses.

`describeSpell(row)` is the serializable face of a spell: its path, its sentence, the
`paramsDocument` the row rendered at registration, and its capability list. It is total — the render
that can fail already happened. The closure never leaves the kernel.

## Scope, and who resolves it

`Scope` ([`spell.ts`](../apps/tuval/src/commands/spell.ts)) is where a call came from:

```ts
interface Scope {
	readonly window?: WindowId;
	readonly process?: ProcessId;
	readonly workspace: WorkspaceId;
	readonly client: ClientId;
}
```

A workspace and a client are always known. A window and a process are known only when the caller was
inside one.

`resolveScope` ([`scope.ts`](../apps/tuval/src/commands/scope.ts)) builds it. The wire lets a page
name the window it called from and nothing else: the process and the workspace are looked up through
`WindowIndex`, so a page cannot address another process by putting an id on the wire. A spell that
legitimately targets another process takes that id as a parameter of its own `params`.

`WindowIndex` is an interface this slice declares and the shell implements. Until the shell adopts
it, `WindowIndex.scripted(table)` answers from a fixture. A window the index does not hold is
`NoSuchWindow`.

## The executor

`SpellExecutor.execute(call, client)`
([`executor.ts`](../apps/tuval/src/commands/executor.ts)) is a `SpellCall` in and a `SpellReply`
out. Its error channel is `never`: every way a call can go wrong becomes a failed outcome on the
reply, so a caller has exactly one thing to read.

The steps are lookup, decode the args, resolve the scope, run, encode the result.

| Failure | Becomes |
|---|---|
| no spell at the path | `UnknownSpell`, carrying the nearest registered path when one is near enough. The measure is Levenshtein and the budget is `Math.max(1, Math.ceil(path.length / 3))`, so a short path still tolerates one edit |
| `params` refuses the args | `BadArgs`, carrying the offending argument and what was expected |
| the window is unknown | `NoSuchWindow` |
| the spell's own tagged error | a failure whose `tag` and `message` come off the error |
| the spell's own untagged failure (a bare string, a plain record, a thrown value) | `SpellFailed`, carrying the value on `original` and rendering it into the message; the executor also logs it through `Effect.logError` |
| `result` refuses the return value | `BadResult`, and the fiber **dies**; that is the spell author's bug, not the caller's |

A failure's `path` is always the call's own, so a spell's private error cannot claim a different
one.

Every `tag` a reply can carry is read off an error object's `_tag`, never composed as a literal:
`AnySpell` erases the spell's error type, so a failure with no `_tag` is wrapped in `SpellFailed`
before the reply is built. That is what keeps a page's `switch` on `tag` matching names that
resolve to a declared class.

`AnySpell` erases each spell's requirements, so nothing checks that the runtime carries what a
registered spell needs. The composition root that builds the registry owes those services.

## Key bindings

A binding is written the way a person types it (`"window close"`), and a key router needs
`{path, args}`. `compileBindings(source, table)`
([`bindings/compile.ts`](../apps/tuval/src/commands/bindings/compile.ts)) does that conversion once,
at config load.

A `KeyBindings` record maps a key string to either a command string or
`{command, repeat?}`. The output is `{bindings, errors}`:

- Each compiled `Binding` carries `key`, `path`, `args` decoded against the spell's real `params`
  (so a `count` is a number, not `"3"`), and `repeat` only when the config asked for it.
- Each command that does not compile becomes a `BindingError` and is dropped. Recovery is per
  binding: a bad one costs its own key and nothing else. The loader's whole-config fallback stays
  reserved for an unimportable module or a top-level schema error.

`BindingError` ([`bindings/errors.ts`](../apps/tuval/src/commands/bindings/errors.ts)) carries five
things and renders them in that order: which module, which key, the character offset inside the
command string, what was expected, and the nearest thing the author may have meant. `file` comes
from `describeFile` ([`bindings/file.ts`](../apps/tuval/src/commands/bindings/file.ts)), which names
the layer plus the path *inside* that layer's directory and falls back to the bare file name rather
than leaking an absolute path.

The reading is the parser's own `parse`, so a binding is read by exactly the rules a typed line will be read
by. Compilation is against the registry as it stands, so a spell that goes away turns its binding
into an error on the next compile — which is why nothing calls `compileBindings` directly except
`SpellSet`, below, where re-running it is not something a caller can forget.

## The set boot holds

`SpellSet` ([`spell-set.ts`](../apps/tuval/src/commands/spell-set.ts)) is the registry table, the
config's key sources and the bindings compiled from them, held in **one** `Ref` and written in one
`Ref.set`. Two cells would be two states to keep in step, and keeping them in step is the whole
job: a binding is only ever as valid as the table it was compiled against.

Its layer hands out `SpellSet` **and** `SpellRegistry`, both reading that one cell, so a reader's
single `Ref.get` sees both halves of one config. Every write goes through the same private step,
which compiles the bindings against the table it is about to store:

| Entry | What it does |
|---|---|
| `SpellSet.read` | the table, its key sources and the compiled bindings, as one value |
| `SpellSet.reload(input)` | a fresh table from new program rows, fresh bindings, installed in one write |
| `SpellRegistry.swap(table)` | the narrower entry, which recompiles the bindings rather than leaving them behind, holding the cell across the compile so a concurrent reload cannot land inside it |

`everyPath(table)` is the whole registry as an allowlist, which is what `src/boot.ts` passes the
bridge today.

Boot joins the set, the executor, the bridge and `SpawnedProcesses` to the kernel's layers
(`start` in [`boot.ts`](../apps/tuval/src/boot.ts)), reports the spell count beside the program
count, and prints one line per key binding that did not compile. `Booted.reload` reads the config
layers again and calls `SpellSet.reload`; it replaces the spells and the bindings and nothing else,
so processes already running keep running under the rows they were spawned from. The two proofs are
[`src/reload-proof.unit.test.ts`](../apps/tuval/src/reload-proof.unit.test.ts) (the swap, with a
reader watching across it) and
[`src/commands/agent-proof.unit.test.ts`](../apps/tuval/src/commands/agent-proof.unit.test.ts),
which runs one script twice: once as a plain scripted program sending `SpellCall`s over the wire,
and once as a process built by `aiAgentProgram` over `ScriptedAiAgent.layer`, reaching the same
spells through `SpellBridge`.

A config module is imported with a per-load number on its URL
([`config.ts`](../apps/tuval/src/config.ts)), because Node caches an ES module by URL for the life
of the process and a reload of the same path would otherwise answer with the config the first boot
read.

## The parser

The parser is total, synchronous and never throws, because the page runs it on every keystroke and
the kernel runs it over the key bindings at load.

`tokenize(input)` ([`parse/tokenize.ts`](../apps/tuval/src/commands/parse/tokenize.ts)) is the
lexer. Whitespace separates, double quotes group, a backslash escapes the next character inside a
quoted run as well as outside one. Every `Token` carries `text` (quotes and escapes resolved) plus
the raw `start` and `end` offsets, because a refusal points at a position on a line the user is
still typing. The `Tokenization` also reports `trailingSeparator` (the caret sits on a fresh empty
token) and `openQuote`.

`read(input, registry)` ([`parse/reading.ts`](../apps/tuval/src/commands/parse/reading.ts)) is the
single walk `parse` and `complete` share. Two rules make it incremental:

1. **The caret's token is still being typed.** It is the last token, or a fresh empty one when the
   line ends on a separator. A committed token that names nothing is a refusal; the caret's token
   only has to be a prefix of something.
2. **The deepest registered spell on the walk wins**, and every token after its path is an argument.
   Positional arguments fill parameters in declaration order; a token shaped `name=value` whose
   `name` is an unbound parameter binds by name, and one naming a parameter the line already bound
   is refused with "<name> is already bound" rather than read as a positional value. Rule 1 outranks
   rule 2 where they meet.

Arguments bind as text. The only *value* the parser refuses is one outside an enum parameter's
literals, which is the check the kernel would make anyway, made here so a page running this parser cannot
accept what the kernel rejects. It also refuses a token with no parameter left to bind to, with
`no further arguments`.

`parse(input, registry, snapshot)` ([`parse/parse.ts`](../apps/tuval/src/commands/parse/parse.ts))
answers one of three (the second parameter is named `registry` and its type is `SpellIndex`):

| `_tag` | Carries |
|---|---|
| `Complete` | a `SpellCallDraft`: `path` plus `args` as token text. The correlation id and the calling window are the caller's, so they are not on the draft |
| `Partial` | the spell named so far when there is one, the parameter the caret is on, and the ranked candidates |
| `Refused` | the offending token's offset, what was expected, and a suggestion when there is one |

### The spell index

`buildSpellIndex(descriptions)`
([`parse/spell-index.ts`](../apps/tuval/src/commands/parse/spell-index.ts)) builds the trie the
parser walks, from the protocol's `RegistryDescription`. That is the same value a `Snapshot`
carries, so the page and the kernel run this parser over identical input. A `RegistryTable` would
carry richer types and the page cannot hold one: it has descriptions, never closures.

`readParams` flattens a description's JSON-Schema `params` to an ordered `ParamSpec` list. Three
properties of that rendering are load-bearing, all read off `Schema.toJsonSchemaDocument` at the
`catalogs.tuval` pin (effect `4.0.0-rc.112`): the `properties` key order is the declaration order of
`Schema.Struct`, which is the positional order of the parameters; a `Schema.Literals` parameter
arrives as `{"type": "string", "enum": [...]}`; and a `Schema.Class` params, or any
identifier-annotated struct, renders its root as `{"$ref": "#/$defs/<name>"}` with the object itself
under the document's `definitions`, so the root ref is followed once before the properties are read.
Everything else is read defensively, because the module is total.

`describeExpected(param)` renders one slot: `<name>`, or the literals joined by `|`.

## Completion

`complete(input, registry, snapshot)`
([`parse/complete.ts`](../apps/tuval/src/commands/parse/complete.ts)) ranks the candidates for the
token under the caret. Two rules, and they never mix:

1. **Exact prefix, for names the system defines.** Spell path segments, program ids, and an enum
   parameter's literals. A name is offered only when the caret's text is a prefix of it, in registry
   or snapshot order. `win` never reaches `wizard-inspect`.
2. **Fuzzy subsequence, for values a user named.** Window ids, process ids, workspace ids and
   workspace names off the snapshot. The caret's characters must appear in order; the tighter and
   earlier the run, the higher the rank. `scr` reaches `scratch`.

**Both rules ignore case** (#7757). One `fold` in the module lowercases each side for the prefix
filter and the subsequence scorer alike, so `W` offers exactly what `w` offers at a segment, a
literal, a program id and a window id. Rule 1's "recall, don't search" argument is about the matching
rule, not about capitalization.

**The fuzzy rank is over the tightest run in the value, not the first run found** (#7757). The scorer
tries every start the query's first character reaches and keeps the lowest
`(span * 1000) + first` — `a-xb-ab` matches `ab` scattered at 0-3 and contiguous at 5-6, and it is
ranked by 5-6.

Which live set a parameter draws from is decided by its own name: a parameter named for a window, a
process, a program or a workspace offers that set, and one named for none of them offers no live
values.

Only the fuzzy rule sorts. The prefix rule is a plain `.filter`, so it hands back the registry or
snapshot order untouched. A fuzzy tie breaks on the `recency` stamp every window and process row
carries, most recent first (#7617 R1.5): the kernel bumps one counter over the whole desk and stamps
a window on focus and a row on spawn, so two equally tight matches are ordered by which was touched
last. A value with no stamp of its own — a workspace name, a workspace id — ties on collection order
instead, and `Array.prototype.sort` is required to be stable (ECMA-262 §23.1.3.30), so two calls
over one snapshot return one list.

A `Candidate` carries `value` (the text that replaces the caret's token), a `kind`
(`segment` / `program` / `literal` / `window` / `process` / `workspace`), and the spell's sentence on
a segment that completes a whole spell.

Both rules run synchronously against the snapshot the page already holds, so completion needs no
round trip.

## The core spells

`helpSpells` ([`core/index.ts`](../apps/tuval/src/commands/core/index.ts)) is the three discovery
spells as one list.

- **`help [path]`** ([`core/help.ts`](../apps/tuval/src/commands/core/help.ts)) lists every spell, or
  only the ones under one path. There is no help text in the file: a row's `describe` is the
  registry's own, and `usage` is derived by running `readParams` and `describeExpected` over the
  description. A prefix that matches nothing answers `UnknownSpell`, carrying a suggestion only when
  one is near enough. `segmentsOf` accepts both separators, because a typed line uses spaces and a
  refusal renders dots.
- **`spell list`** and **`spell describe <path>`**
  ([`core/spell.ts`](../apps/tuval/src/commands/core/spell.ts)) hand the same table to a program.
  An agent driving Tuval discovers what it can call over exactly the wire a human's command line uses.
- **`process spawn` / `process send` / `process read`**
  ([`core/process.ts`](../apps/tuval/src/commands/core/process.ts)) are the generic tools an agent
  program calls, written once for every program. Nothing in the file names a program. A
  `SpawnedProcesses` service retains the handle of every process it spawns, because the process
  table exposes rows and no dispatch; `send` and `read` answer `UnknownProcess` for a process this
  service did not spawn.

### The bridge

`SpellBridge` ([`bridge/SpellBridge.ts`](../apps/tuval/src/commands/bridge/SpellBridge.ts)) is
`list` and `call`, and neither mentions a program. An agent program's SDK tool is a wrapper over it,
so a second agent program costs an adapter and no new spell.

`call(path, args, scope)` refuses a path outside the allowlist with `SpellNotAllowed`
([`bridge/errors.ts`](../apps/tuval/src/commands/bridge/errors.ts)) before the executor is reached.
`SpellBridge.layer({allow})` takes that allowlist from whoever builds the layer, and no program
row's field is wired into it: `src/boot.ts` passes `everyPath` over the table as it stands at boot,
and `bridge/bridge.unit.test.ts` passes its own. What makes the file program-blind is that no
program id is written in it. The intent recorded in the module's own docblock is that a calling
program's registry row will supply the list, and that wiring is a later child's. Because the layer
captures the list at build, a config reload leaves it behind while the registry moves on —
[#7743](https://github.com/kamp-us/phoenix/issues/7743) is filed on that.

`call` puts only the scope's window on the wire, so the executor re-resolves the process exactly as
it does for a page.

`SpellBridge.scripted(table)` answers from a fixed table and runs nothing, so it has no allowlist to
enforce.

An AI agent process reaches the bridge through its `TuvalAiAgent` layer, which is where a real
program's SDK tool would sit. `ScriptedAiAgent` has no SDK, so its script says what to call: a
turn's optional `plan` ([`ai-agent/service/script.ts`](../apps/tuval/src/ai-agent/service/script.ts))
names one spell at a time out of the answers the turn already has, and the script's `spells` holds
the `SpellBridgeApi` those calls go through plus the `Scope` each one carries. Every answer lands on
the session's transcript as a `tool` item, so the run reads back as the conversation it was.

### An agent program's adapter over the bridge

The Claude program's is the first one, under
[`apps/tuval/src/claude/tools/`](../apps/tuval/src/claude/tools). It is the shape every later agent
program copies, and it is three files:

- [`KernelBridge.ts`](../apps/tuval/src/claude/tools/KernelBridge.ts) — `spawn`, `send` and `read` as
  Effects. `KernelBridge.live(scope)` calls the three `process` spells through `SpellBridge` with the
  calling process's own `Scope`; `KernelBridge.scripted(table)` is the deterministic fake, and each
  build of it gets its own state.
- [`errors.ts`](../apps/tuval/src/claude/tools/errors.ts) — the four the adapter answers with. The
  executor flattens a spell's typed error to a `SpellFailure`'s `tag` and sentence, so an adapter
  re-reads that tag into an error of its own; the fields the caller already knows are its own, and
  whatever else the kernel said rides in `detail`. That is where `PortRefused` names the port's kind,
  since the wire carries no field for it.
- [`server.ts`](../apps/tuval/src/claude/tools/server.ts) — `tuvalToolServer(bridge, run)`, three
  `tool()` definitions on one `createSdkMcpServer({name: "tuval"})`. The server name is half of every
  wire name (`mcp__tuval__spawn`), so it is written once and `wireNames` is derived from it. Handlers
  are plain `async` functions and the Effect runs *inside* one, through a `ToolRuntime` the calling
  process built: the SDK offers no hook for handing it a runtime.

No program id is written in that directory, and
[`boundary.unit.test.ts`](../apps/tuval/src/claude/tools/boundary.unit.test.ts) is what keeps it that
way.

## The Tuval protocol

One versioned page-to-kernel wire
([`protocol/messages.ts`](../apps/tuval/src/protocol/messages.ts)). `PROTOCOL_VERSION` is `1` and
every message carries it, so a page and a kernel from different builds refuse each other by decode
rather than by behaviour.

Four messages, one `Schema.Class` each:

| Message | Direction | Fields |
|---|---|---|
| `SpellCall` | page to kernel | `id`, `path`, `args` (opaque here), optional `window` |
| `SpellReply` | kernel to page | `id`, plus `ok: true, result` or `ok: false, error` |
| `Snapshot` | kernel to page | `rev`, `desk`, `windows`, `processes`, `registry` |
| `Patch` | kernel to page | `rev`, `changes`: path-addressed replaces |

`SpellCall` is the only page-to-kernel message: windows, keys and the command line all speak this
one shape. `PageToKernel` is the union of that one; `KernelToPage` is the union of the other three.

`SpellReply` is the flat union of `SpellReplyOk` and `SpellReplyError`, which is what holds `ok`
and its payload together: a reply carrying both a result and an error is a member of neither class,
so it cannot be built or decoded. `isSpellReply` is the reply leg of `KernelToPage`, since
`instanceof` cannot answer for a union. `SpellFailure` carries `tag`, `message`, and optionally `path`,
`expected` and `didYouMean`, which is enough for a client to render an error inline under its input.

Every window and every process row on a `Snapshot` carries a `recency` stamp: one monotonic counter
over the whole desk, bumped when a window takes focus and when a process spawns, so the highest
stamp is whatever was touched last. It is a counter and not a `lastFocusedAt` for the reason
`Revision` is one — the kernel holds no clock, a counter is deterministic under test, and the page
only ever compares two stamps, so a wall time would buy nothing and cost clock skew.
[`protocol/recency.ts`](../apps/tuval/src/protocol/recency.ts) mints it, beside the schema that
declares it and for the same reason `applyPatch` lives there. Completion reads it to break a fuzzy
tie; no shell holds windows yet, so `focusWindow` has no production caller.

The registry rides in the `Snapshot` as a `RegistryDescription`
([`protocol/registry-description.ts`](../apps/tuval/src/protocol/registry-description.ts)), so the
parser's index is built without a round trip.

JSON text is the whole wire. There is no binary framing and there are no channels. A program that
streams raw bytes is what reopens that.

### Codec, ids, patch

[`protocol/codec.ts`](../apps/tuval/src/protocol/codec.ts) exports four functions,
`decodePageMessage` / `decodeKernelMessage` / `encodePageMessage` / `encodeKernelMessage`. A decode
is total: it answers with the message or with `ProtocolRefused`
([`protocol/errors.ts`](../apps/tuval/src/protocol/errors.ts)) naming the direction and the schema
issue. Nothing throws and nothing resolves a malformed frame to a partial value.

[`protocol/json.ts`](../apps/tuval/src/protocol/json.ts) holds the module's native `try`/`catch`,
on purpose: reading and writing untrusted JSON needs it, the repo bans it inside Effect control
flow, so the boundary lives in its own module with no `effect` import and the codec wraps it. Both
directions answer a value rather than throwing — `parseJson` is `Parsed | Failed`, `stringifyJson`
is `Stringified | Failed`. The write needs the same guard as the read because `SpellCall.args`,
a reply's `result` and `Replace.value` are all `Schema.Unknown`: encode is identity there, so a
BigInt or a cycle reaches the writer untouched and encode fails with `ProtocolRefused`.

[`protocol/ids.ts`](../apps/tuval/src/protocol/ids.ts) re-declares `ProcessId` and `ProgramId`
rather than importing them from the kernel slices, which keeps the protocol module independent by
construction. It costs nothing at the type level: `Schema.brand` is keyed on the literal brand
string, so `"tuval/ProcessId"` here and in `src/process/process.ts` are one type to the checker.

`applyPatch(snapshot, patch)` ([`protocol/patch.ts`](../apps/tuval/src/protocol/patch.ts)) encodes,
walks each replace path, then decodes the result back as a `Snapshot`. The decode is the point: a
patch that would leave the desk in a shape the protocol does not admit is refused with
`PatchRefused` rather than delivered. A replace never creates a key.

The revision check is `patch.rev !== snapshot.rev + 1`, so a patch applies over exactly the
revision below it: a patch at `rev + 7` is refused rather than applied over a gap, and so is one
older than the snapshot. That is what the refusal message ("does not follow") and the comment on
`Patch` in [`protocol/messages.ts`](../apps/tuval/src/protocol/messages.ts) ("it applies only over
the revision just below it") have always said; the check used to be wider than both, which is
[#7689](https://github.com/kamp-us/phoenix/issues/7689).

[`protocol/issue.ts`](../apps/tuval/src/protocol/issue.ts) turns an Effect `SchemaError` into
`{expected, at}`, which is what every refusal in the slice interpolates.

It takes the failing input as a second operand, and that operand serves one case: a direction union
whose discriminants rule out every member. The parser narrows a union by its literal fields before
it tries a member, so when `type` or `version` matches nothing there is no member left to fail and
the `AnyOf` carries no issue — Effect then formats it as a dump of all four candidate shapes, at no
path. `issue.ts` reads that empty `AnyOf` itself: it re-derives each member's literal fields off the
public `SchemaAST` nodes, narrows them in declaration order against the input, and answers with the
field that emptied the set — `Expected 1, got 2 at version` for a snapshot from a different build,
`Expected "spell.call", got "spell.cast" at type` for a name nothing owns. A message whose
discriminants do pick a member keeps that member's own issue unchanged. A non-object frame keeps the
dump: no field is at fault there. Why this is worth the AST walk is
[#7760](https://github.com/kamp-us/phoenix/issues/7760) — `version` is exactly what
`PROTOCOL_VERSION` exists to catch, and the dump never mentioned it.

## The shell's command rows

The shell declares its named commands under
[`apps/tuval/src/shell/commands/`](../apps/tuval/src/shell/commands) and publishes them as spells on
its own program row, so there is no second command mechanism beside this framework — one registry
answers a bound key, a typed line, `help`, and an agent's bridge.

| File | What is in it |
|---|---|
| [`shell/commands/row.ts`](../apps/tuval/src/shell/commands/row.ts) | `ShellCommand`, `defineCommand`, `CommandPath`, `commandName`, `commandPath`, `parameterNames` |
| [`shell/commands/table.ts`](../apps/tuval/src/shell/commands/table.ts) | `shellCommands`, `commandFor`, `commandNames`, `resolveVerb`, `verbSpellings`, `msgForCommandName` |
| [`shell/commands/line.ts`](../apps/tuval/src/shell/commands/line.ts) | `readCommandLine`, `CommandLineResult` |
| [`shell/commands/errors.ts`](../apps/tuval/src/shell/commands/errors.ts) | `CommandRefusal` and its five arms, `refusalMessage` |
| [`shell/commands/spells.ts`](../apps/tuval/src/shell/commands/spells.ts) | `shellSpells`, `CommandDispatched` |
| [`shell/commands/dispatch.ts`](../apps/tuval/src/shell/commands/dispatch.ts) | `ShellDispatch` |

A row is `defineCommand({path, describe, params, toMsg})`. It is the same shape as a spell minus the
executing: `toMsg` takes the decoded parameters and returns one `ShellMsg`
([`shell/core/machine.ts`](../apps/tuval/src/shell/core/machine.ts)), so a row captures no context,
returns no Promise, and is data a test drives directly. Whatever a command needs from the world
rides on the Msg's own Cmd — `window:open` becomes `window.open`, whose cell emits the picker's
`openProgram` Cmd, and the spawning stays where the registry and the process table are.

`commandName` joins the path with colons (`window:close`), which is the spelling a key binding uses;
`commandPath` reads it back. One derivation each way, so a row cannot carry a name its path
disagrees with, and the prefix table's `CommandName`
([`shell/keys/table.ts`](../apps/tuval/src/shell/keys/table.ts)) needs no second vocabulary.

`msgForCommandName` is the one place a bound key's name becomes a Msg, and `shell/core/machine.ts`
calls it — so a key press and a typed line run the same row. It answers `null` for a row that needs
an argument, because a key sequence has nowhere to carry one, and the core leaves that name as a
`runCommand` Cmd.

`readCommandLine` lexes with this framework's `tokenize` and suggests with its `didYouMean`, then
binds the tokens positionally in `Schema.Struct` declaration order and decodes them against the
row's real schema through `Schema.decodeUnknownResult`. That is the difference from `parse` above:
the palette's parser binds argument *text* and leaves the decode to the executor, so its refusal
names a position; this one has the schema in hand, so its refusal names the row and the parameter.
A verb resolves as the full name, else the `window:` row of that name, else an unambiguous last
segment — `open` is claimed by both `window:open` and `command:open`, and the `window:` step is what
keeps `:open counter` readable rather than a guess.

Two rows are declared elsewhere and lifted here: `window:open` and `window:attach` come from
`pickerCommands` ([`shell/picker/intent.ts`](../apps/tuval/src/shell/picker/intent.ts)), where the
picker put them so the argument grammar would sit beside the handler that consumes it. The table
reads their name, sentence and argument kind off that list rather than re-typing them.

`shellSpells` wraps each row as a spell whose `execute` builds the Msg and hands it to
`ShellDispatch`, an interface this slice declares — the same shape `WindowIndex` takes above.
`AnySpell` erases that requirement, so the composition root that builds the registry owes the
service, and [`boot.ts`](../apps/tuval/src/boot.ts) pays it: `shellDispatchKernel(shellId)`
([`shell/commands/kernel.ts`](../apps/tuval/src/shell/commands/kernel.ts)) sits in the same merge
as `SpellBridge`, finds the live process of the shell's program row through
`ProcessTable` per dispatch, and puts the Msg on it. `Kernel` names `ShellDispatch` and `Context` is
contravariant in its services, so dropping that layer stops `start` compiling rather than leaving a
defect for the first caller. The layer lives in its own module rather than beside the tag because
`dispatch.ts` is on the page's import path and the process table reads `node:crypto` at load; the
page's boundary test walks the runtime import graph from `src/page/main.tsx` and refuses any
`node:` specifier, so the split is proven rather than remembered (#7910).

`dispatch` fails typed rather than dying, because a desk is a process: a config that registers the
shell row but plans no node for it answers `NoDesk`, and a desk that stopped mid-call answers the
actor's own `DispatchError`. Either way the executor turns it into a `SpellReplyError`, so `help`,
a typed line and an agent's bridge all read a refusal instead of meeting a defect. The proof is
[`src/shell/proof/dispatch.unit.test.ts`](../apps/tuval/src/shell/proof/dispatch.unit.test.ts),
which boots, calls a row through both the executor and the bridge, reads the desk back, and takes
the service out of the returned kernel to show the same call dying without it.

## The palette

The palette is one desk-level overlay at the top center of the whole app, fixed width, never tied to
a window's box, the way VS Code, Neovim and tmux do it. The focused window supplies scope only: a
spell run from the palette still targets the focused window, because scope comes from focus and not
from where the palette sits.

It lives in [`apps/tuval/src/palette/`](../apps/tuval/src/palette)
([ADR 0348](../.decisions/0348-tuval-command-framework-spell-registry-versioned-protocol.md) carries
the why and the sequencing), and it is the second door onto the command table the `<prefix> :` line
already opens — never a second mechanism.

| File | What is in it |
|---|---|
| [`Palette.tsx`](../apps/tuval/src/palette/Palette.tsx) | The overlay: one combobox, the ranked list, the focused row's sentence, the last refusal |
| [`candidates.ts`](../apps/tuval/src/palette/candidates.ts) | `paletteCandidates`, `acceptCandidate` — what the list holds and what accepting a row types |
| [`call.ts`](../apps/tuval/src/palette/call.ts) | `spellCallFor`, `failureLine` — a read line into a `SpellCall`, a `SpellFailure` into one sentence |
| [`use-palette.ts`](../apps/tuval/src/palette/use-palette.ts) | `usePalette`: open/closed, the opener's window, the element the caret goes back to |
| [`palette.css`](../apps/tuval/src/palette/palette.css) | Geometry only. Every colour is a `@kampus/design` role token; `tokens.unit.test.ts` scans for a literal one |

**The palette lists spells; the command line completes segments.** `complete` above answers with the
*segment* under the caret, which is what a line being typed wants — one more word. A palette wants
the runnable thing, so `paletteCandidates` walks the trie past the matching segment and lists every
spell beneath it with its `describe`: typing `win` offers `window close`, `window move` and
`window focus`, not the bare word `window`. On a value slot it hands straight back to
`candidatesFor`, so the fuzzy-on-recency rule is unchanged. Prefix on the paths the system defines,
fuzzy on the values a user named — one rule per slot, the same split `complete` makes.

**One field, and the rows are never focusable.** The ARIA combobox pattern: the caret stays in the
input for the palette's whole life and the active row is named by `aria-activedescendant`. That is
what frees Tab to mean "accept this completion" the way a shell does, and it is also what closes the
focus trap — the input is the only tabbable element in the dialog, so Tab from it comes back to it.
Enter runs a line the parser can already read and spends itself on the completion otherwise.

**Nothing focuses a row, so the component owes two things the browser would otherwise do.** It
scrolls the active row into view itself on every `aria-activedescendant` change
(`scrollIntoView({block: "nearest"})`, with the list's `scroll-behavior` pinned to `auto` so it is a
jump under either motion preference) — without it, End on a list taller than its own box moves a
selection out of sight. And it speaks: one visually-hidden `aria-live="polite"` region carries the
refusal while there is one and the result count otherwise, since a reader with no sight of the list
learns a keystroke's effect from nothing else. `aria-expanded` follows the list rather than sitting
at a literal `true`, so it and `aria-activedescendant` never disagree about whether a popup exists.

**A reply is a prop, not `onCall`'s return.** Replies arrive on the page's one socket rather than per
call, so the caller forwards every reply and the palette consumes the one whose `id` matches the call
it sent — once, keyed on the value passed rather than on the id, since the id is the caller's to
mint. An `ok: false` keeps the palette open with the kernel's own words under the input; the next
`ok: true` closes it.

**Who supplies the registry and runs the call** is
[`shell/ui/PaletteHost.tsx`](../apps/tuval/src/shell/ui/PaletteHost.tsx): it describes the shell's
own rows as `SpellDescription`s, builds the `Snapshot` the completion engine reads, and — until the
page-to-kernel spell transport lands — decodes a call against the row's real `params` and dispatches
its Msg, exactly as `readCommandLine` does with a typed line.
