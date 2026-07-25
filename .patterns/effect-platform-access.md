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

All three are members of the one `NodeServices.layer` (grounded in
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

## The before / after — the real call sites (#3461)

`packages/pipeline-crew-mcp/src/standup/register-local-scope.ts` and
`.../orchestrate.ts` reach straight for the builtins.

### The before — welded to the real disk

```ts
// register-local-scope.ts (today)
import {existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {dirname, join, sep} from "node:path";
import {randomUUID} from "node:crypto";

const atomicWrite = (path: string, content: string): void => {
	const temp = join(dirname(path), `.claude.json.crew-${randomUUID().slice(0, 8)}.tmp`);
	writeFileSync(temp, content);   // synchronous, throws, no seam
	renameSync(temp, path);
};
```

Because the IO is a raw `writeFileSync`, the unit test can only inject a temp
*path* and let the code hit the real disk on it (the module's own note: "the IO
wrapper is exercised against an injected temp path"). The filesystem itself is not
substitutable — the test is forced to touch real disk and clean up after itself.

### The after — the platform is already in scope; just `yield*` the service

The crew-mcp bin already provides the whole platform:

```ts
// packages/pipeline-crew-mcp/src/bin.ts (today — unchanged)
import {NodeRuntime, NodeServices} from "@effect/platform-node";
cli.pipe(Command.run({version: VERSION}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
```

So the layer is *already wired* — the call sites just bypass it. The migrated shape
routes the same atomic write through the `FileSystem` seam:

```ts
import {Effect, FileSystem, Path} from "effect";

const atomicWrite = Effect.fn("LocalScope.atomicWrite")(function* (target: string, content: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const temp = path.join(path.dirname(target), `.claude.json.crew-${crypto.randomUUIDv4}.tmp`);
	yield* fs.writeFileString(temp, content);
	yield* fs.rename(temp, target);
});
```

A `unit` test now substitutes `FileSystem.FileSystem` with a fake layer — no temp
path to inject, no real disk touched, the whole seam scripted (see
[Testing](#testing--substitute-the-filesystem-seam)).

> The migration of these call sites is **not** this doc's job — it's the separate
> sweep tracked in [#3462](https://github.com/kamp-us/phoenix/issues/3462). This doc
> is the target the sweep migrates *toward*.

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
- **A `node:*`-only API the platform service doesn't expose.** `proper-lockfile`
  (advisory lockfiles) and `fileURLToPath` (`import.meta.url` → path) have no
  `FileSystem`/`Path` method; keep the raw call and wrap it in an `Effect.try` with a
  typed error, as the existing code does.
- **Deliberate real-fs test code.** A test that means to touch the real filesystem
  (an `integration`-style fixture) may use `node:fs` directly — the point is the real
  disk, so there's nothing to substitute.

The rule is not "never write `node:`" — it's "**domain Effect code depends on the
platform service, so the filesystem stays a swappable seam.**" When you keep a raw
`node:*` call, keep it at a boundary (a param default, a bin, an `Effect.try`
wrapper), never woven through a service method.

## Directory walks — `Dirent` is `lstat`, `FileSystem.stat` is `stat` (never a straight swap)

> [!WARNING]
> **A `readdirSync(…, {withFileTypes: true}) + entry.isDirectory()` → `fs.stat(abs).type === "Directory"`
> migration is NOT semantics-preserving.** It silently *widens* a recursive walk to descend
> symlinked directories. In a fail-closed CI guard that widening is directional — it can only
> add files to the scanned corpus, so a RED becomes GREEN: the guard fails **open**. CI cannot
> catch it, because a fresh checkout contains no stray symlinks.

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
[#3462](https://github.com/kamp-us/phoenix/issues/3462) migration waves:
[#3472](https://github.com/kamp-us/phoenix/issues/3472) / PR
[#3898](https://github.com/kamp-us/phoenix/pull/3898) (`patch-guard`) — **confirmed fail-open**, a
`@patch-pin:` marker behind a symlinked dir flipped the gate RED→GREEN, now fixed;
[#3470](https://github.com/kamp-us/phoenix/issues/3470) / PR
[#3897](https://github.com/kamp-us/phoenix/pull/3897) (`design-token-guard`) and
[#3471](https://github.com/kamp-us/phoenix/issues/3471) / PR
[#3915](https://github.com/kamp-us/phoenix/pull/3915) (`reachability-guard`) — latent, same shape.

### The sanctioned idiom — gate the `Directory` arm on `readLink` failing

`readLink` is `effectify(NFS.readlink, …)` (`NodeFileSystem.js:280`) and POSIX `readlink(2)`
succeeds **only** on a symbolic link (`EINVAL` on anything else) — so "`readLink` succeeded" is the
`lstat`-free test for link-ness. Keep `stat` for the type, gate the recursion on it. Shipped shape,
`packages/pipeline-cli/src/tools/patch-guard/gate.ts` (`gatherMarkers`), covered by two
`gate.unit.test.ts` cases that plant a real symlinked dir and a real symlinked file:

```ts
const walk = (dir: string): Effect.Effect<void, PlatformError.PlatformError> =>
	Effect.gen(function* () {
		for (const name of yield* fs.readDirectory(dir)) {
			const abs = path.join(dir, name);
			const stat = yield* fs.stat(abs);
			if (stat.type === "Directory") {
				const isSymlink = yield* fs.readLink(abs).pipe(
					Effect.as(true),
					Effect.orElseSucceed(() => false),
				);
				if (!isSymlink && !IGNORE_DIRS.has(name)) yield* walk(abs);
				continue;
			}
			// … the file arm: a symlinked FILE still stats as "File" and stays in scope,
			// which matches the Dirent walk — hence the guard sits on the Directory arm only.
		}
	});
```

Reach for this **first** when migrating any walk. Following symlinked dirs is a deliberate
behavior change, not a migration detail — if a tool genuinely wants it, say so and take on the two
obligations below.

### Two obligations that ride along with the swap

- **Symlink-cycle guarding.** An ignore list that screens by directory *name*
  (`node_modules`/`dist`) was cycle-immune under `Dirent`/`lstat` semantics — a link was never
  recursed, so a cycle was unreachable. Once symlinked dirs are followed, `a/link → ..` is
  unbounded recursion (stack overflow, not a typed failure). A walk that follows links **must**
  carry a visited-set keyed on `fs.realPath(abs)`, or a depth cap. The `readLink` gate above sidesteps
  this entirely, which is the second reason to prefer it.
- **Broken-symlink tolerance.** `fs.stat` on a dangling link fails (`ENOENT`) — as a
  `PlatformError` on the `E` channel, so one broken symlink anywhere under the walk root hard-fails
  the whole gate, where the `Dirent` walk classified the entry and moved on. If the walk stats every
  entry, make the per-entry stat skippable (`Effect.option` / `Effect.orElseSucceed`) rather than
  letting a stray dangling link decide a gate's exit code.

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
