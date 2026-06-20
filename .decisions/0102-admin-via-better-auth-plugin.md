---
id: 0102
title: Admin Capability via better-auth Admin Plugin, CLI-Surfaced
status: accepted
date: 2026-06-20
tags: [auth, admin, cli]
---

# 0102 — Admin Capability via better-auth Admin Plugin, CLI-Surfaced

## Context

Epic [#873](https://github.com/kamp-us/phoenix/issues/873) was scoped as a web admin *dashboard*. Wrong first move: the operator surface for kamp.us is the CLI ([#11](https://github.com/kamp-us/phoenix/issues/11)/[#113](https://github.com/kamp-us/phoenix/issues/113)), not a browser — and admin functionality is a *server* capability regardless of which client drives it. Meanwhile `moderator-grant` ([ADR 0098](0098-moderation-role-resolution-lifecycle.md)) flips `user.role='moderator'` via a direct-D1 operator script — "the only sanctioned grant path, never a runtime worker route" — *because* the deleted `/api/admin/*` was fail-open and no authenticated admin API exists. So an admin capability is currently hand-rolled as a credential-holding direct-D1 client purely for lack of a server surface. (This amends ADR 0098's grant-path clause only — see Consequences.)

## Decision

Admin capability is a **server-side better-auth admin plugin mounted on the worker** (`apps/web/worker`), extending the existing better-auth instance with authenticated, fail-closed admin endpoints (list/search users, set role, ban/unban with reason+expiry, session revoke, impersonation, create/remove user, set password).

- **The CLI is the client surface, not the capability.** `kampus admin …` verbs are authenticated HTTP clients of the worker's admin API. No web UI is built now (deferred, possibly never); a UI, if ever, is just another client.
- **The CLI primitive is the generic role verb**, mirroring better-auth's `setRole`: `kampus admin role set <user> <role>` (scales to admin/moderator/future roles). Domain sugar (`kampus admin moderator grant`) is deferred until it earns its keep.
- **moderator-grant is deprecated then retired, not converted.** Its substance — a direct-D1 role write — is exactly what the server plugin obsoletes; converting its transport would leave a redundant second surface. Sequence: (1) mount the plugin; (2) build `kampus admin role …`; (3) deprecate moderator-grant (docblock/README point at the CLI verb, kept working one cycle as fallback); (4) retire it once the CLI path is proven. Its UX (grant/revoke/list verbs, `--username`|`--user-id` selector) is design input for the verb, not code to port.

## Consequences

- The plugin's role/permission model becomes a **shared server-side substrate**: kampus-cli consumes it as a client, and künye's privilege-gating ([#146](https://github.com/kamp-us/phoenix/issues/146)) enforces against it in-worker. (How künye binds to it is decided in künye's own enforcement-surface ADR, not here.)
- One capability, one place (the worker) — no parallel admin systems; the CLI stays a thin client.
- **Amends ADR 0098 (partial supersede — grant-path clause ONLY):** the sanctioned moderator-grant path becomes the authenticated admin-plugin API, not direct-D1. ADR 0098's intent — no *fail-open* public admin route — is preserved (the plugin is fail-closed with real auth + role checks). The REST of ADR 0098's moderation-role-resolution lifecycle stands; 0098 is NOT fully superseded.
- Reshapes epic [#873](https://github.com/kamp-us/phoenix/issues/873) from "admin dashboard UI" to "server-side admin plugin (capability) + kampus-cli admin verbs (client); web UI out of scope." Two work streams: (a) mount the plugin [foundation, apps/web/worker]; (b) kampus-cli admin verbs [client, part of the kampus-cli epic].
- A web admin UI is explicitly out of scope; revisiting it is a future decision, cheap because the capability already exists server-side.
- New dependency surface: the better-auth admin plugin (verify exact method surface + permissions model against the pinned better-auth version before implementation).
