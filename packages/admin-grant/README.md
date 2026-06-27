# @kampus/admin-grant

Offline direct-D1 CLI that grants/revokes **platform-admin authority** and lists
the current admins (issue #1236).

Admin authority is the relation-backed `Admin` capability (ADR 0107): a subject
is an admin iff it holds the `(subject, "admin", "platform:platform")` tuple in
`relation_tuple`, which the worker's `Admin.over(platform)` discharge reads fresh
per call. So granting/revoking admin is minting/dropping that one tuple. This is
**not** better-auth's AC model — ADR 0107 supersedes ADR 0102's better-auth-AC
authorization substrate; better-auth stays for authn + the user-management UI.

It is granted only by a **server-side direct-D1 script, never a runtime worker
route** — per CLAUDE.md's "Sözlük seed" section, the admin mutation routes were
deleted as a fail-open hole, so the tuple is written by an operator who holds the
D1 write token. There is no in-product way to make someone an admin; this package
is that path. It is the `admin` twin of `@kampus/moderator-grant` (which grants
the `moderates` relation), authored as Node tooling — an Effect CLI
(`effect/unstable/cli`) — not Python, not an ad-hoc script.

## What it does

| Command  | Effect                                                                  |
| -------- | ----------------------------------------------------------------------- |
| `grant`  | mints `(subject, "admin", "platform:platform")` (by `--username` or `--user-id`) |
| `revoke` | drops that tuple                                                        |
| `list`   | prints the current admin subjects                                       |

The selector is resolved to the subject's user id through the `user` table, so
"no such user" (`subject: null`) reads distinctly from a real grant, and an admin
tuple is never minted for a non-existent user. `grant` is idempotent
(`onConflictDoNothing`), so a re-run reads `inserted: 0`.

## Architecture

A pure, unit-tested core + a thin Effect bin (the repo tooling idiom):

- `src/grant.ts` — the pure core: `assignAdmin`/`revokeAdmin`/`listAdmins` over a
  `D1Database` slice. The object key is `@kampus/authz`'s canonical `key(platform)`,
  the SAME encoding the worker's `RelationStoreLive` reads with, so a granted tuple
  is found by `Admin.over(platform)` (the write→read seam).
- `src/schema.ts` — the `relation_tuple` + `user` columns this writes/reads (a
  narrow local copy of the canonical `apps/web/worker/db/drizzle/schema.ts`).
- `src/bin.ts` — the `admin-grant grant|revoke|list` CLI.

## Running it

Targets a **named stage's D1** (never prod-hardcoded).

```bash
node packages/admin-grant/src/bin.ts grant  --username <handle> --database-id <stage-d1-uuid>
node packages/admin-grant/src/bin.ts grant  --user-id <id>      --database-id <stage-d1-uuid>
node packages/admin-grant/src/bin.ts revoke --username <handle> --database-id <stage-d1-uuid>
node packages/admin-grant/src/bin.ts list                       --database-id <stage-d1-uuid>
```

- `--database-id` (required) — the deployed stage's D1 UUID (resolve from the
  alchemy state store, or `@distilled.cloud/cloudflare/d1`'s `getDatabase`).
- `--username` / `--user-id` (`grant`/`revoke`) — pass exactly one; the selector
  the grant is keyed on.
- `--account-id` (optional) — defaults to `$CLOUDFLARE_ACCOUNT_ID`.
- `$CLOUDFLARE_API_TOKEN` — the minted token (carries `D1 Write`); read by
  `CredentialsFromEnv`.

Transport is the Cloudflare D1 REST query API via alchemy's already-installed
`@distilled.cloud/cloudflare` — the same primitive alchemy uses to apply
migrations to a deployed D1, so no new Cloudflare dependency and no workerd.
