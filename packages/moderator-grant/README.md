# @kampus/moderator-grant

Offline direct-D1 CLI that grants/revokes the **`moderator` role** and lists the
current moderators (issue #938).

`user.role = "moderator"` is the server-managed moderation capability (ADR 0098
§1). It is granted only by a **server-side direct-D1 script, never a runtime
worker route** — per CLAUDE.md's "Sözlük seed" section, the admin mutation routes
were deleted as a fail-open hole, so the role flip is a CLI run against the bound
database by an operator who holds the D1 write token. There is no in-product way
to make someone a moderator; this package is that path.

It's authored as Node tooling — an Effect CLI (`effect/unstable/cli`), mirroring
`@kampus/preview-seed` / `@kampus/leak-guard` — not Python, not an ad-hoc script.

## What it does

| Command  | Effect                                                           |
| -------- | --------------------------------------------------------------- |
| `grant`  | sets a user's `role` to `moderator` (by `--username` or `--user-id`) |
| `revoke` | sets it back to `member`                                         |
| `list`   | prints the current moderators (id + username)                   |

`grant`/`revoke` update one user keyed on the chosen selector and report the
changed-row count, so "no such user" (`changed: 0`) reads distinctly from a real
flip (`changed: 1`) — the run never silently no-ops.

## Architecture

A pure, unit-tested core + a thin Effect bin (the repo tooling idiom):

- `src/grant.ts` — the pure core: `setRole`/`listModerators` over a `D1Database`
  slice. Flips `user.role` by id or username; returns the changed-row count.
- `src/schema.ts` — the `user` columns this writes (a narrow local copy of the
  canonical `apps/web/worker/db/drizzle/migrations` columns).
- `src/d1-rest.ts` — the `D1Database`-shaped REST adapter (the bin's only
  transport; the integration tier runs the same path against real D1).
- `src/bin.ts` — the `moderator-grant grant|revoke|list` CLI.

## Running it

Targets a **named stage's D1** (never prod-hardcoded).

```bash
node packages/moderator-grant/src/bin.ts grant  --username <handle> --database-id <stage-d1-uuid>
node packages/moderator-grant/src/bin.ts grant  --user-id <id>      --database-id <stage-d1-uuid>
node packages/moderator-grant/src/bin.ts revoke --username <handle> --database-id <stage-d1-uuid>
node packages/moderator-grant/src/bin.ts list                       --database-id <stage-d1-uuid>
```

- `--database-id` (required) — the deployed stage's D1 UUID (resolve from the
  alchemy state store, or `@distilled.cloud/cloudflare/d1`'s `getDatabase`).
- `--username` / `--user-id` (`grant`/`revoke`) — pass exactly one; the selector
  the role flip is keyed on.
- `--account-id` (optional) — defaults to `$CLOUDFLARE_ACCOUNT_ID`.
- `$CLOUDFLARE_API_TOKEN` — the minted token (carries `D1 Write`); read by
  `CredentialsFromEnv`.

Transport is the Cloudflare D1 REST query API via alchemy's already-installed
`@distilled.cloud/cloudflare` — the same primitive alchemy uses to apply
migrations to a deployed D1, so no new Cloudflare dependency and no workerd.
