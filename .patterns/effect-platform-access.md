# Reaching the platform through Effect — `FileSystem` / `Path` / `Crypto`, not `node:*`

How Effect code in phoenix touches the host platform — the filesystem, paths,
process-unique ids — as an Effect service instead of importing `node:fs` /
`node:os` / `node:path` directly. The service is the swappable seam: a method that
`yield*`s `FileSystem.FileSystem` can be exercised against a substituted in-memory
filesystem in a `unit` test, while a raw `readFileSync` welds the code to the real
disk. This is the platform-access counterpart of the subprocess shell in
[effect-process-cli-shell.md](./effect-process-cli-shell.md) — same substrate, same
substitution win, applied to files/paths instead of `gh`/`git`. The Effect substrate
is ADRs [0027](../.decisions/0027-http-router-drop-hono.md) /
[0028](../.decisions/0028-effect-durable-object-model.md).

> [!IMPORTANT]
> **phoenix is on Effect v4** (`effect@4.0.0-beta.*`). The platform services live on
> the `effect` package itself — `import {FileSystem, Path} from "effect"`, tags
> `FileSystem.FileSystem` / `Path.Path`, `Crypto.Crypto` for random ids — and the Node
> implementations come from **`@effect/platform-node`** as **`NodeServices.layer`**.
> The v3 idiom most training data shows — `FileSystem` from `@effect/platform`,
> `NodeContext.layer` / `NodeFileSystem.layer` from `@effect/platform-node` — does
> **not** apply. `NodeContext` is a v3 name; the v4 union is `NodeServices`
> (`ChildProcessSpawner | Crypto | FileSystem | Path | Stdio | Terminal`, one
> `NodeServices.layer`). Grounded in effect-smol `packages/effect/src/FileSystem.ts` +
> `packages/effect/src/Path.ts` (both `@since 4.0.0`, module docblocks) and
> `packages/platform-node/src/NodeServices.ts`.

## When to use it

Any Effect code — a service method, an `Effect.fn`, a layer body — that reads or
writes files, builds or resolves paths, makes a temp directory, or mints a random
id. Reach for the service, not the `node:*` builtin:

| Raw `node:*` | Effect service (from `effect`) | Node layer member |
|---|---|---|
| `node:fs` (`readFileSync`, `writeFileSync`, `existsSync`, `mkdirSync`, `renameSync`, `rm`) | `FileSystem.FileSystem` (`readFileString`, `writeFileString`, `exists`, `makeDirectory`, `rename`, `remove`, `makeTempDirectory`, `stat`) | `NodeFileSystem.layer` |
| `node:path` (`join`, `dirname`, `basename`, `resolve`, `sep`) | `Path.Path` (`join`, `dirname`, `basename`, `resolve`, `normalize`, `sep`) | `NodePath.layer` |
| `node:crypto` (`randomUUID`) | `Crypto.Crypto` (`randomUUIDv4` / `randomUUIDv7`) | `NodeCrypto.layer` |
| `node:fs` on **fd 0** (`readFileSync(0, "utf8")` — reading stdin) | `Stdio.stdin`, a chunked `Stream` — **considered and declined; fd 0 stays raw** ([the bright line](#the-bright-line--when-raw-node-is-still-correct)) | `NodeStdio.layer` |

All of these are members of the one `NodeServices.layer` (grounded in
`packages/platform-node/src/NodeServices.ts`), so a bin that already provides
`NodeServices.layer` has the whole platform in scope for free — see
[the after](#the-after--already-in-scope-just-yield-the-service). Every operation
fails with `PlatformError` on the `E` channel (grounded in `FileSystem.ts` — the
module boundary is `PlatformError`), so a fault is a typed value, never a thrown
exception.

## The canonical shape

`yield*` the service tag, then call its methods. The service is the layer's
requirement; nothing in the method body names `node:*`.

```ts
import {Effect, FileSystem, Path} from "effect";

const readConfig = Effect.fn("Config.read")(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const configPath = path.join(dir, ".claude.json");
	if (!(yield* fs.exists(configPath))) {
		yield* fs.writeFileString(configPath, "{}");
	}
	return yield* fs.readFileString(configPath);
	// a missing file / unwritable dir is a PlatformError on E — not a throw
});
```

The method's `R` carries `FileSystem | Path`; the caller discharges it by providing
the Node layer once, at the bin. Grounded in effect-smol
`packages/effect/src/FileSystem.ts` (§"Accessing file system operations" module
example) and LLMS.md §"Writing Effect services" (the `yield*`-the-tag idiom).

## The before / after — a real call site

### The before — welded to the real disk

```ts
import {existsSync, readFileSync, renameSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {randomUUID} from "node:crypto";

const atomicWrite = (target: string, content: string): void => {
	const temp = join(dirname(target), `.tmp-${randomUUID().slice(0, 8)}`);
	writeFileSync(temp, content);   // synchronous, throws, no seam
	renameSync(temp, target);
};
```

Because the IO is a raw `writeFileSync`, a unit test can only inject a temp *path* and let the
code hit the real disk on it. The filesystem itself is not substitutable — the test is forced to
touch real disk and clean up after itself. Worse, a `existsSync` probe reports an unreadable
parent directory as "absent", so a could-not-read is silently answered as a definite `false`.

### The after — the platform is already in scope; just `yield*` the service

A CLI bin already provides the whole platform once, at the entry point:

```ts
// packages/fabrika-cli/src/run.ts
import {NodeRuntime, NodeServices} from "@effect/platform-node";
cli.pipe(Command.run({version: VERSION}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
```

So the layer is *already wired* — a call site reaching for `node:fs` is just bypassing it. The
shipped seam is [`packages/fabrika-cli/src/io/fs.ts`](../packages/fabrika-cli/src/io/fs.ts), which
routes every read and write through the service and **lowers `PlatformError` into a tagged
failure** rather than a sentinel value:

```ts
import {Effect, FileSystem} from "effect";

/** The file's UTF-8 text. A file that could not be read FAILS; it never resolves to `""`. */
export const readFile = (path: string): Effect.Effect<string, ReadFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.readFileString(path);
	}).pipe(
		Effect.catchTag("PlatformError", (cause) => new ReadFailed({path, reason: cause.message})),
	);
```

That is the whole point of the seam, and it is why "I could not read this" stays distinguishable
from "I read this and it held nothing": the two take opposite branches, and only the `E` channel
forces a caller to decide between them. A unit test substitutes `FileSystem.FileSystem` with a
scripted layer — no temp path to inject, no real disk touched (see
[Testing](#testing--substitute-the-filesystem-seam)).

## The bright line — when raw `node:*` is still correct

The mandate is for **Effect control flow**. A raw `node:*` import is acceptable, and
sometimes the only option, in these grounded cases:

- **A node primitive with no `@effect/platform` service.** `node:os`'s `homedir()`
  has **no** platform equivalent in Effect v4 — there is no `Os` service and no
  `homeDir` on `FileSystem`/`Path` (verified absent across effect-smol
  `packages/effect/src` + `packages/platform-node/src`). Read it once at the boundary
  from `node:os` and thread the resolved value as a plain string, exactly as
  `register-local-scope.ts` already does (`claudeConfigPath(home = homedir())` — the
  home is a parameter default, injectable in a test). Don't invent a service that
  doesn't exist to satisfy the rule.
- **Bin-level platform composition.** The bin *provides* the platform
  (`Effect.provide(NodeServices.layer)`) and may name `@effect/platform-node`
  members directly — that's the wiring seam, not domain control flow. Likewise a
  socket/runtime layer (`NodeSocket.layerNet`, `NodeRuntime.runMain`) is composed at
  the edge, not `yield*`ed in a method.
- **A `node:*`-only API the platform service doesn't expose.** `fileURLToPath`
  (`import.meta.url` → path) has no `FileSystem`/`Path` method; keep the raw call and
  wrap it in an `Effect.try` with a typed error, as the existing code does. (The other
  standing example, `proper-lockfile`'s advisory lockfiles, left with the v1 crew's MCP
  package under ADR [0279](../.decisions/0279-v1-crew-retired-in-full.md) — the rule is
  unchanged, it just has one live instance now.)
- **Deliberate real-fs test code.** A test that means to touch the real filesystem
  (an `integration`-style fixture) may use `node:fs` directly — the point is the real
  disk, so there's nothing to substitute.
- **Reading stdin (fd 0) at a CLI boundary.** A `readFileSync(0, "utf8")` stays raw —
  but **not** for the first bullet's reason, which is the tempting and wrong
  justification here. Effect v4 *does* ship a stdin seam: `Stdio.stdin` is a
  `Stream.Stream<Uint8Array, PlatformError>` (`effect/dist/Stdio.d.ts` at the pinned
  `effect@4.0.0-beta.92`), `Stdio` is a member of the same `NodeServices` union as
  `FileSystem`/`Path` (`@effect/platform-node/dist/NodeServices.d.ts`), and
  `packages/pipeline-cli/src/run.ts` already provides `NodeServices.layer` — so the
  service exists and is in scope. What is genuinely absent is a **`FileSystem`** route:
  every member of the v4 `FileSystem` interface is keyed by a `path: string`, and the only
  `File.Descriptor` it hands out comes from `fs.open(path)`. The exported
  `FileSystem.FileDescriptor` brands a bare number, but **no method on the interface
  accepts a descriptor** and there is no `File` constructor that adopts an already-open fd
  — so a fd-0 read has no route through the seam (`effect/dist/FileSystem.d.ts` contains
  no `stdin` at all). So this is a **considered-and-declined** call on `Stdio.stdin`, on
  two grounds:

  - **A sync read-to-EOF and a chunked stream drain are not observably equivalent.**
    They differ in buffering, in how a multi-byte character split across chunks decodes,
    and in when a read fault surfaces. Swapping one for the other is a behavior change to
    decide on its own merits, not a migration detail.
  - **`Stdio` is outside the charter.** The migration sweep
    ([#3462](https://github.com/kamp-us/phoenix/issues/3462)) is scoped to `node:fs` /
    `node:path` / `node:crypto`; pulling a fourth service in mid-wave is how a
    behavior-preserving refactor stops being one.

  **The ruling, so it isn't re-derived per PR: fd 0 stays a raw `node:fs` read at the
  boundary**, while the *sibling path branch* of the same helper routes the `FileSystem`
  seam. `readBody` in `packages/pipeline-cli/src/tools/verdict/command.ts` is the shape
  (`--body-file` → `fs.readFileString`, else `readFileSync(0, "utf8")`); `leak-guard`'s
  `readCommentBody` and `redact-leaks`' `readBody` carry the same split. Routing fd 0 through
  `Stdio.stdin` **eventually** is a live option, not a closed door — but it is its own
  decision with its own behavior-preservation bar, and it must preserve whatever fd-0
  failure semantics the raw read carries
  ([#3924](https://github.com/kamp-us/phoenix/issues/3924) is hardening exactly those),
  not merely typecheck.

  **The reasoning generalizes to fd 1/2, and stops there.** Writing to stdout/stderr has
  the same shape — `Stdio` exposes them as `Sink`s, so a raw `process.stdout.write` is
  the same considered-and-declined call, not a missing service. Any *other* inherited
  descriptor (an fd 3 handed down by a parent) has no equivalent in either `FileSystem`
  or `Stdio`, and so falls under the first bullet instead.

  **A failed `--body-file` read stays a hard defect — never a silent fall back to
  stdin.** The two branches are not interchangeable: a `--body-file` naming a path that
  cannot be read is a caller error, and degrading it to "read stdin instead" turns a
  broken flag into an *empty body* that a gate then decides over — the zero-input
  fail-open class ADR
  [0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md) exists to stop. Keep the
  path branch's failure hard (`verdict`'s `Effect.orDie`, or a typed failure that exits
  non-zero) and let the stdin branch run only when no path was given at all. `class-probe`'s
  `readFiles` used to be the counter-example — an unreadable `--files-from` was absorbed to
  `""`, i.e. to *no files*, so an unread input and an empty one were one value. It now resolves
  an unreadable path to `null` and refuses non-zero on it, while a readable-but-empty file still
  classifies through the tool's own fail-closed no-input path — the two outcomes stay distinct
  in both value and exit code ([#4061](https://github.com/kamp-us/phoenix/issues/4061); the
  stdin half was [#3924](https://github.com/kamp-us/phoenix/issues/3924)).

The rule is not "never write `node:`" — it's "**domain Effect code depends on the
platform service, so the filesystem stays a swappable seam.**" When you keep a raw
`node:*` call, keep it at a boundary (a param default, a bin, an `Effect.try`
wrapper), never woven through a service method.

## Directory walks — `Dirent` is `lstat`, `FileSystem.stat` is `stat` (never a straight swap)

> [!WARNING]
> **A `readdirSync(…, {withFileTypes: true}) + entry.isDirectory()` → `fs.stat(abs).type === "Directory"`
> migration is NOT semantics-preserving.** It silently *widens* a recursive walk to descend
> symlinked directories. That widening only ever *adds* files to the scanned corpus, so for a
> **negation-shaped** predicate — assert-nothing-is-missing (`!consumingConstants.has(…)`, "no
> matching `@patch-pin:`"), the shape most of the guard stack has — a RED becomes GREEN and the
> guard fails **open**. (A positively-shaped predicate only gains violations: GREEN→RED, noisy but
> fail-closed.) CI cannot catch it, because a fresh checkout contains no stray symlinks.
>
> **So the only detection method is a differential A/B of the built binaries against a planted
> symlink fixture:** build the pre-migration base and the head, plant a real symlinked dir / a real
> symlinked file / a dangling link under the walk root, run both binaries over that tree, and diff
> exit code + report. A code review of the diff will not surface the widening (the swapped line reads
> as equivalent), and no CI job can — the fixture cannot exist in a checkout.

The three facts, at the pinned `effect@4.0.0-beta.92` / `@effect/platform-node-shared@4.0.0-beta.92`:

| Before (`node:fs`) | After (v4 `FileSystem`) | What changed |
|---|---|---|
| `readdirSync(dir, {withFileTypes: true})` → `Dirent[]` | `fs.readDirectory(dir)` → `Array<string>`, options `{recursive?: boolean}` only (`effect/dist/FileSystem.d.ts:170`) | **No `withFileTypes`** — you get names, no per-entry type |
| `entry.isDirectory()` / `entry.isFile()` — **`lstat`**-based, does **not** follow symlinks | `(yield* fs.stat(abs)).type === "Directory"` — `stat` is `effectify(NFS.stat, …)` (`@effect/platform-node-shared/dist/NodeFileSystem.js:311`), i.e. node `fs.stat`, which **follows** symlinks | A symlink-to-dir is `false` under `Dirent`, `"Directory"` under `stat` |
| `lstatSync(abs)` | — | The v4 `FileSystem` interface has **no `lstat`** at all (absent from `effect/dist/FileSystem.d.ts`) |

`File.Info.type` is not an escape hatch either: `makeFileInfo` reports `"SymbolicLink"` only for a
stat that *is* a link (`stat.isSymbolicLink()`), which `fs.stat` never returns — so
`type === "SymbolicLink"` is dead code on that path.

Observed instances of the swap, for reviewers of the remaining
[#3462](https://github.com/kamp-us/phoenix/issues/3462) migration waves — all four are `readLink`-gated
on `main` today; none is still latent. The **pre-migration file arm** is recorded for each, because it
is what decides which arm the gate belongs on (the base-polarity table below):

- [#3472](https://github.com/kamp-us/phoenix/issues/3472) / PR
  [#3898](https://github.com/kamp-us/phoenix/pull/3898) — `patch-guard`, **confirmed fail-open**: a
  `@patch-pin:` marker behind a symlinked dir flipped the gate RED→GREEN. Base file arm was
  `if (!statSync(abs).isFile() || !isTestFile(entry.name)) continue;` — a link-*following* `statSync`.
- [#3470](https://github.com/kamp-us/phoenix/issues/3470) / PR
  [#3897](https://github.com/kamp-us/phoenix/pull/3897) — `design-token-guard` (`walkCss`), fixed in
  the migration PR. Base file arm screened by name only (`e.name.endsWith(".css")`).
- [#3471](https://github.com/kamp-us/phoenix/issues/3471) / PR
  [#3915](https://github.com/kamp-us/phoenix/pull/3915) — `reachability-guard`, fixed in the
  migration PR. Base file arm was the bare `} else if (matches(entry.name)) {` — **no type test at all**.
- [#3471](https://github.com/kamp-us/phoenix/issues/3471) / PR
  [#3915](https://github.com/kamp-us/phoenix/pull/3915) — `workflow-contract`, the **counter-example**:
  its base file arm was a *positive* `.filter((e) => e.isFile() && e.name.endsWith(".js"))`, so
  symlinked `.js` files were **excluded** at base and its gate sits on the **file** arm — the opposite
  direction from the other three.

### The sanctioned idiom — reconstruct `lstat` with `readLink`

`readLink` is `effectify(NFS.readlink, …)` (`NodeFileSystem.js:280`) and POSIX `readlink(2)`
succeeds **only** on a symbolic link (`EINVAL` on anything else) — so "`readLink` succeeded" is the
`lstat`-free test for link-ness. Keep `stat` for the type; put the `readLink` test on whichever arm
the walk you are replacing already excluded links from.

#### First establish the call site's base polarity — it decides which arm to guard

**Which arm the gate belongs on is a property of the pre-migration line, not a constant.** Read that
line before copying anything:

| Pre-migration file arm | Symlinked files were… | The gate goes on |
|---|---|---|
| a negated `Dirent` **directory** test whose else-branch is the file arm (`if (entry.isDirectory()) { … } else { /* file arm */ }`), a link-**following** `statSync(abs).isFile()`, or **no type test at all** | in scope | the **`Directory`** arm only — the file arm needs nothing |
| a *positive* `entry.isFile()` test | **excluded** — `Dirent.isFile()` is `lstat`-based, so a link-to-file is `false` | the **file** arm, **ahead of** the type test |

**The discriminator is admission, not grammatical negation.** `isFile` is `lstat`-based and
**excludes** links; `isDirectory` is `lstat`-based too and therefore **admits** a link-to-dir into the
else/file arm. So `if (!entry.isFile()) continue` admits exactly what a positive `entry.isFile()`
admits — the `!` sits on control flow, not on membership — and belongs in row **two**, not row one.
Guard whichever arm **newly gains** the link after the swap: an `isFile` base widens the **file** arm
(`fs.stat` follows the link and reports `"File"`), an `isDirectory()`-else base widens the
**recursion** (the link stats as `"Directory"` and is recursed). A link-**following** `statSync`
already followed links before the swap, so it changes nothing on its own arm — it sits in row one
only because such a walk's *directory* test is still `Dirent`-based (`patch-guard`).

Both polarities ship in this repo, which is why the trail above records each site's base arm: three
sites guard the `Directory` arm, `workflow-contract` guards the file arm.

**Directory-arm shape** (the common case). The `readLink` gate is `patch-guard`'s `gatherMarkers`
(`packages/pipeline-cli/src/tools/patch-guard/gate.ts`, covered by two `gate.unit.test.ts` cases that
plant a real symlinked dir and a real symlinked file); the `Effect.option` stat and the
dangling-entry split are `design-token-guard`'s `walkCss`
(`packages/pipeline-cli/src/tools/design-token-guard/gate.ts`). Copy **both** — the `readLink` gate
alone satisfies obligation 1 below but not obligation 2:

```ts
const walk = (dir: string): Effect.Effect<void, PlatformError.PlatformError> =>
	Effect.gen(function* () {
		for (const name of yield* fs.readDirectory(dir)) {
			const abs = path.join(dir, name);
			const stat = yield* Effect.option(fs.stat(abs));
			if (Option.isNone(stat)) {
				// Dangling link (or an entry racing an unlink): in scope iff the walk's OWN name
				// predicate matches, per obligation 2 — never a blanket skip.
				if (isTestFile(name)) found.push(abs);
				continue;
			}
			if (stat.value.type === "Directory") {
				const isSymlink = yield* fs.readLink(abs).pipe(
					Effect.as(true),
					Effect.orElseSucceed(() => false),
				);
				if (!isSymlink && !IGNORE_DIRS.has(name)) yield* walk(abs);
				continue;
			}
			// No gate on the file arm AT THIS POLARITY: a symlinked file stats as "File" and stays
			// in scope, which is what a base arm of this polarity admitted (see the table above).
			if (isTestFile(name)) found.push(abs);
		}
	});
```

**File-arm shape**, when the base arm was a positive `Dirent.isFile()` — the gate moves *ahead of*
the type test so a symlinked entry never reaches it
(`packages/pipeline-cli/src/tools/workflow-contract/gate.ts`):

```ts
if (!name.endsWith(".js")) continue;
const isSymlink = yield* fs.readLink(abs).pipe(Effect.as(true), Effect.orElseSucceed(() => false));
if (isSymlink) continue; // reconstructs the base `Dirent.isFile()`, which excluded links
if ((yield* fs.stat(abs)).type === "File") scripts.push(abs);
```

Reach for the shape matching your call site's polarity **first** when migrating any walk. Following
symlinked dirs is a deliberate behavior change, not a migration detail — if a tool genuinely wants
it, say so and take on the two obligations below.

### Two obligations that ride along with the swap

- **Symlink-cycle guarding.** An ignore list that screens by directory *name*
  (`node_modules`/`dist`) was cycle-immune under `Dirent`/`lstat` semantics — a link was never
  recursed, so a cycle was unreachable. Once symlinked dirs are followed, `a/link → ..` is
  unbounded recursion (stack overflow, not a typed failure). A walk that follows links **must**
  carry a visited-set keyed on `fs.realPath(abs)`, or a depth cap. The `readLink` gate above sidesteps
  this entirely, which is the second reason to prefer it.
- **Broken-symlink tolerance — skippable at the *stat*, then split by the name predicate.**
  `fs.stat` on a dangling link fails `ENOENT` as a `PlatformError` on the `E` channel, so a walk that
  stats every entry unconditionally lets one stray link hard-fail the whole gate, where the `Dirent`
  walk classified the entry by name and moved on. Make the per-entry stat skippable
  (`Effect.option` / `Effect.orElseSucceed`) — but do **not** then drop every dangling entry, because
  the base walk did not treat the two halves alike:
  - name **does not** match the walk's predicate → **skip it**, exactly as the `Dirent` walk did (it
    matched neither arm);
  - name **does** match → **keep it in scope** and let the downstream read red the gate. This is
    `design-token-guard`'s deliberate choice in `walkCss`, settled in PR
    [#3897](https://github.com/kamp-us/phoenix/pull/3897)'s repair round: a `.css` file replaced by a
    dangling link must stay "gate reds" rather than become "file silently leaves scope."

  That choice carries one **accepted residual**, recorded so nobody reads it as a fresh defect: a
  link *named* `*.css` whose target is a **directory** resolves through `fs.stat` as `"Directory"`
  and is skipped as a symlinked dir (exit 0), where the base walk pushed it by name and hard-failed
  at `readFileSync` with `EISDIR` (exit 1). That divergence is tracked separately in
  [#3950](https://github.com/kamp-us/phoenix/issues/3950) — do not "fix" it by reverting the split
  above.

  Skippability belongs on the stat, never on the downstream read. `reachability-guard`
  (`packages/pipeline-cli/src/tools/reachability-guard/gate.ts`) tests `readLink` before `stat`, so it
  never fails *at the stat* — but that is not blanket tolerance: a dangling `*.tsx` is still pushed by
  `matches(name)` and then reds at `gatherConsumers`'s unguarded `fs.readFileString` (`ENOENT` →
  `IoError` → exit 1), while a dangling non-matching entry is silently ignored. Two exit codes, one
  per side of the split — which is the correct behavior, not an exemption from this obligation.

## Testing — substitute the `FileSystem` seam

The `FileSystem`/`Path` requirement is exactly what a `unit` test replaces
([effect-testing.md](./effect-testing.md)) — the same substitution the subprocess
shell does with `ChildProcessSpawner`
([effect-process-cli-shell.md](./effect-process-cli-shell.md)) and feature code does
with `Drizzle`. Provide a fake `FileSystem` layer (a scripted double answering canned
reads/writes, or one whose ops fail with `PlatformError` to exercise the error path)
in place of `NodeFileSystem.layer`; the method under test never touches real disk.
This is strictly stronger than today's inject-a-temp-path workaround: the *whole*
filesystem is the seam, not just the path it writes to. Follow the
`layerStub`/`layerNoop` test-double grammar in [effect-testing.md](./effect-testing.md).

## See also

- [effect-process-cli-shell.md](./effect-process-cli-shell.md) — the sibling platform shell: shelling `gh`/`git` over `effect/unstable/process` (`ChildProcessSpawner`), same substitution win for subprocesses
- [effect-context-service.md](./effect-context-service.md) — the `Context.Service` + layer shape the platform services follow (v4 `Context.Service`, not v3 `Context.Tag`)
- [effect-layer-composition.md](./effect-layer-composition.md) — providing `NodeServices.layer` and composing the platform requirement into a bin/worker
- [effect-testing.md](./effect-testing.md) — the `unit` tier and the seam-substitution grammar the `FileSystem` fake follows
- [effect-errors.md](./effect-errors.md) — modeling the typed error a `PlatformError` folds into at a boundary
