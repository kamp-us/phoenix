# @kampus/admin-grant

Offline direct-D1 CLI that grants/revokes **platform-admin authority** and lists
the current admins (issue #1236).

## What it is

Node tooling — an Effect CLI (`effect/unstable/cli`), the `admin` twin of
[@kampus/founder-seed](../founder-seed/README.md) (which writes the `moderates`
relation), not Python, not an ad-hoc script. Admin authority is the relation-backed
`Admin` capability ([ADR 0107](../../.decisions/0107-capability-authz-framework.md)):
a subject is an admin iff it holds the `(subject, "admin", "platform:platform")`
tuple in `relation_tuple`, which the worker's `Admin.over(platform)` discharge reads
fresh per call. So granting/revoking admin is minting/dropping that one tuple.

| Command  | Effect                                                                           |
| -------- | -------------------------------------------------------------------------------- |
| `grant`  | mints `(subject, "admin", "platform:platform")` (by `--username` or `--user-id`) |
| `revoke` | drops that tuple                                                                 |
| `list`   | prints the current admin subjects                                                |

The surfaces a consumer touches, file by file:

- **`src/grant.ts`** — the pure, unit-tested core: `assignAdmin` / `revokeAdmin` /
  `listAdmins` over a `D1Database` slice, plus `makeGrantDb`, the drizzle handle.
  The object key is `@kampus/authz`'s canonical `key(platform)` — the SAME encoding
  the worker's `RelationStoreLive` reads with, so a granted tuple is found by
  `Admin.over(platform)` (the write→read seam). Re-exported through **`src/index.ts`**
  together with the `ADMIN` / `PLATFORM` constants and the result types
  (`AssignResult`, `RevokeResult`, `Selector`, …).
- **`src/schema.ts`** — the `relation_tuple` + `user` columns this writes/reads (a
  narrow local copy of the canonical `apps/web/worker/db/drizzle/schema.ts`, which is
  not an exported subpath).
- **`src/bin.ts`** — the `admin-grant grant|revoke|list` CLI the operator runs.

The selector resolves to the subject's user id through the `user` table, so "no such
user" (`subject: null`) reads distinctly from a real grant and no tuple is ever
minted for a non-existent user. `grant` is idempotent (`onConflictDoNothing`), so a
re-run reads `inserted: 0`.

## Why it exists

[ADR 0107](../../.decisions/0107-capability-authz-framework.md) made authority
relation-backed, so an admin is exactly a tuple-holder — there is nothing else to
flip. The tuple is granted only by a **server-side direct-D1 script, never a runtime
worker route**: per [CLAUDE.md](../../CLAUDE.md)'s "Sözlük seed" section, the admin
mutation routes were deleted as a fail-open hole, so the tuple is written by an
operator who holds the D1 write token. There is no in-product way to make someone an
admin; this package is that path. This is **not** better-auth's AC model — ADR 0107
supersedes [ADR 0102](../../.decisions/0102-admin-via-better-auth-plugin.md)'s
better-auth-AC authorization substrate; better-auth stays for authn + the
user-management UI.

Scope: the CLI targets a **named stage's D1, never prod-hardcoded** — the caller
supplies `--database-id` on every invocation.

## How to use it

Run the bin directly (or through the package's `grant` / `revoke` / `list` scripts):

```bash
node packages/admin-grant/src/bin.ts grant  --username <handle> --database-id <stage-d1-uuid>
node packages/admin-grant/src/bin.ts grant  --user-id <id>      --database-id <stage-d1-uuid>
node packages/admin-grant/src/bin.ts revoke --username <handle> --database-id <stage-d1-uuid>
node packages/admin-grant/src/bin.ts list                       --database-id <stage-d1-uuid>
```

Each run prints one line: `ok — …` on a change, `… was already an admin` /
`… was not an admin` / `no user matched …` on a no-op, so every outcome reads
distinctly.

## Reference

Flags and environment the bin reads:

- `--database-id` (required) — the deployed stage's D1 UUID (resolve from the
  alchemy state store, or `@distilled.cloud/cloudflare/d1`'s `getDatabase`).
- `--username` / `--user-id` (`grant`/`revoke`) — pass exactly one; the selector
  the grant is keyed on. Missing both fails with `SelectorRequired`.
- `--account-id` (optional) — defaults to `$CLOUDFLARE_ACCOUNT_ID`.
- `$CLOUDFLARE_API_TOKEN` — the minted token (carries `D1 Write`); read by
  `CredentialsFromEnv`.

Transport is the Cloudflare D1 REST query API via alchemy's already-installed
`@distilled.cloud/cloudflare` — the same primitive alchemy uses to apply migrations
to a deployed D1, so no new Cloudflare dependency and no workerd. A rejected REST
call surfaces as the bin's typed `D1RestError`, not an unhandled defect.

## Testing

```bash
pnpm --filter @kampus/admin-grant test              # the unit tier — pure statement-building, boots no SQL engine
pnpm --filter @kampus/admin-grant test:integration  # real remote Cloudflare D1 over the production REST transport
pnpm --filter @kampus/admin-grant typecheck
```

Unit tests need nothing. Integration tests provision a per-file D1-only stack via
alchemy's `Test.make` and migrate it with the worker's own migrations dir, so they
require `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `ALCHEMY_PASSWORD` — CI
secrets; off-CI they fail at `Unauthorized` by design.
