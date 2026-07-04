# @kampus/depo

The client for **depo** — kampus's internal asset store / CDN ([ADR 0144](../../.decisions/0144-depo-internal-asset-cdn.md)). A thin `put(file)` **library** plus a `depo` **bin** over it. **Not** a `pipeline-cli` subcommand: depo is general infra decoupled from any one consumer, so a non-pipeline caller must not have to pull in the pipeline tool.

## What it is

depo stores an image once, content-addressed and immutable, and serves it at a permanent public URL:

```
https://depo.kamp.us/<sha256>.<ext>
```

This package is the **write** client. It content-addresses a local file (sha256 + extension), presents a pasaport `apiKey`, and calls the [doorman](../../infra/depo/worker/) upload worker (`PUT https://up.depo.kamp.us/`). The **read** path needs no client — a depo URL is a plain anonymous `GET` off `depo.kamp.us`.

## Why it exists

Agents upload Playwright screenshots so they render inside GitHub PR descriptions (and, later, pano/sözlük markdown images). The doorman speaks a small HTTP contract; this lib is the one place that speaks it, so a caller — an agent via the CLI, or a server-side product via `import` — never re-implements content-addressing, auth, or status mapping.

## Use — the CLI

```bash
node src/bin.ts put ./shot.png
# → https://depo.kamp.us/<sha256>.png   (stdout, nothing else)
```

`depo put <file>` uploads an allowlisted image (PNG / JPEG / WebP) and prints **exactly** the public URL to stdout, so a caller can capture it:

```bash
URL=$(node src/bin.ts put ./shot.png)
```

A non-existent file, a non-image, or a rejected upload exits **non-zero** with a legible error on stderr.

### Credential

The `apiKey` is resolved in [ADR 0045](../../.decisions/0045-kampus-client-cli.md) precedence:

1. `--token <key>`
2. `KAMPUS_TOKEN` env var
3. the stored `~/.config/kampus/token` credential

(`$XDG_CONFIG_HOME` is honored when set.) No key at any rung → a non-zero exit with a `MissingCredential` message; the CLI never sends an empty bearer.

## Use — the library

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

`put` (and the bytes-in `putBytes`) talk to the doorman through the injectable `DoormanClient` seam, so the core unit-tests with the seam substituted and **no live worker** — provide `DoormanClientLive` (over any `HttpClient`) for the real upload, or a stub in a test.

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

The content-address key (`<sha256>.<ext>`) and allowlist (PNG / JPEG / WebP) mirror the doorman's own `domain.ts`, so the key the client computes is the key the server stores.

## Develop

```bash
pnpm --filter @kampus/depo test        # vitest unit tier
pnpm --filter @kampus/depo typecheck   # tsgo
pnpm --filter @kampus/depo build       # tsc → dist/
```
