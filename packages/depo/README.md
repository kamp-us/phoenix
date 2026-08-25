# @kampus/depo

The client for **depo** — kampus's internal asset store / CDN ([ADR 0144](../../.decisions/0144-depo-internal-asset-cdn.md)). A thin `put(file)` **library** plus a `depo` **bin** over it.

## What it is

depo stores an image once, content-addressed and immutable, and serves it at a permanent public URL:

```
https://depo.kamp.us/<sha256>.<ext>
```

This package is the **write** client. It content-addresses a local file (sha256 + extension), presents a pasaport `apiKey`, and calls the [doorman](../../infra/depo/worker/) upload worker (`PUT https://up.depo.kamp.us/`). The **read** path needs no client — a depo URL is a plain anonymous `GET` off `depo.kamp.us`.

Nothing here is compiled before use: the package resolves from committed source under the
`development` export condition, and the `depo` bin points at `src/bin.ts`.

The surfaces a consumer touches, file by file (`src/`):

- **`client.ts`** — `put({path, apiKey})` (fs-reading wrapper) and `putBytes` (bytes-in core);
  every doorman HTTP status maps to a typed outcome inside `putBytes`.
- **`live.ts`** — `DoormanClientLive` (the real `PUT` over any `HttpClient`),
  `resolveApiKey` (ADR 0045 credential precedence), `DOORMAN_URL`.
- **`client.ts`'s `DoormanClient`** — the injectable transport seam between the two.
- **`domain.ts`** — the allowlist (`ALLOWED_TYPES`: PNG / JPEG / WebP) and the content address
  (`sha256Hex`, `contentAddressKey`, `publicUrl`, `PUBLIC_HOST`); pure, mirrors the doorman's own
  `domain.ts`.
- **`errors.ts`** — the typed failure set (`MissingCredential`, `UnsupportedFile`, `FileReadError`,
  `DigestError`, `Unauthorized`, `UnsupportedMediaType`, `PayloadTooLarge`,
  `ContentAddressConflict`, `UploadFailed`) — CLI-facing, no `FateWireCode` annotation.
- **`command.ts` / `run.ts` / `bin.ts`** — the `depo put <file>` CLI: argument parsing, error
  reporting, and the one place the real network layer is provided.

## Why it exists

Agents upload Playwright screenshots so they render inside GitHub PR descriptions (and, later,
pano/sözlük markdown images). The doorman speaks a small HTTP contract; this lib is the one place
that speaks it, so a caller — an agent via the CLI, or a server-side product via `import` — never
re-implements content-addressing, auth, or status mapping ([ADR 0144](../../.decisions/0144-depo-internal-asset-cdn.md)).

Scope boundary: depo is general infra, decoupled from any one consumer — **not** a subcommand of
any pipeline tool, so a caller that wants asset storage must not have to pull in a pipeline
toolchain. It owns the write path only: no read client (a depo URL is fetched anonymously), and no
doorman internals (those live under [`infra/depo/worker/`](../../infra/depo/worker/)).

## How to use it

### CLI

```bash
node src/bin.ts put ./shot.png
# → https://depo.kamp.us/<sha256>.png   (stdout, nothing else)
```

`depo put <file>` uploads an allowlisted image (PNG / JPEG / WebP) and prints **exactly** the
public URL to stdout, so a caller can capture it:

```bash
URL=$(node src/bin.ts put ./shot.png)
```

A non-existent file, a non-image, or a rejected upload exits **non-zero** with a legible error on
stderr. `--token <key>` overrides the resolved credential for one call.

### Credential

The `apiKey` is resolved in [ADR 0045](../../.decisions/0045-kampus-client-cli.md) precedence:

1. `--token <key>`
2. `KAMPUS_TOKEN` env var
3. the stored `~/.config/kampus/token` credential

(`$XDG_CONFIG_HOME` is honored when set.) No key at any rung → a non-zero exit with a
`MissingCredential` message; the CLI never sends an empty bearer.

### Library

Server-side products `import` the lib and never touch the CLI:

```ts
import {Effect, Layer} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {DoormanClientLive, put, resolveApiKey} from "@kampus/depo";

const url = await Effect.runPromise(
	Effect.gen(function* () {
		const apiKey = yield* resolveApiKey();
		return yield* put({path: "./shot.png", apiKey});
	}).pipe(Effect.provide(DoormanClientLive.pipe(Layer.provide(FetchHttpClient.layer)))),
);
```

`put` (and the bytes-in `putBytes`) talk to the doorman through the injectable `DoormanClient`
seam, so the core unit-tests with the seam substituted and **no live worker** — provide
`DoormanClientLive` (over any `HttpClient`) for the real upload, or a stub in a test.

## The doorman contract it speaks

The client maps the doorman's HTTP status to a typed outcome ([`infra/depo/worker/`](../../infra/depo/worker/)):

| doorman | meaning | client result |
|---|---|---|
| `201` | created (first write) | the public URL |
| `200` | benign idempotent re-PUT (byte-identical) | the public URL |
| `401` | missing/invalid apiKey | `Unauthorized` |
| `415` | content-type outside the allowlist | `UnsupportedMediaType` |
| `413` | body over the ~10 MB cap | `PayloadTooLarge` |
| `409` | a differing body at an existing content address | `ContentAddressConflict` |
| other / transport | 5xx or a network fault | `UploadFailed` |

The content-address key (`<sha256>.<ext>`) and allowlist (PNG / JPEG / WebP) mirror the doorman's
own `domain.ts`, so the key the client computes is the key the server stores.

## Testing

```bash
pnpm --filter @kampus/depo test        # vitest unit tier
pnpm --filter @kampus/depo typecheck   # tsc
pnpm --filter @kampus/depo build       # tsc → dist/
```

The unit tier runs with the `DoormanClient` seam substituted — no live worker: the suite asserts
the request the client sends and a case per doorman status in the table above.
