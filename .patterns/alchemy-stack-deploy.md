# The stack & deploy

How phoenix is declared and shipped. The short answer: `alchemy.run.ts` is an Effect program — an `Alchemy.Stack` — that declares the resources (the D1 database, the schema, the worker) and returns the stack's outputs. `alchemy deploy` runs it against the Cloudflare API; `alchemy dev` runs it locally. There is no `wrangler.jsonc`.

## The stack

```ts
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import Phoenix from "./apps/web/worker/index";

export default Alchemy.Stack(
  "phoenix",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Drizzle.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Phoenix;
    return {url: worker.url.as<string>()};
  }),
);
```

- **`providers`** — the resource implementations the stack may use (`Cloudflare.providers()` for Workers/D1/DOs/assets; `Drizzle.providers()` for `Drizzle.Schema`). Merge what you need.
- **`state`** — where alchemy stores the deployed-resource state it diffs against. `Cloudflare.state()` keeps it in a Cloudflare-backed store, so deploys are reproducible across machines/CI.
- **body** — yields the resources to deploy and returns the stack outputs (the deployed URL, etc.).

Yielding `Phoenix` deploys the worker; the worker's own init phase (its `bind()` calls and `DurableObjectNamespace` declarations) tells alchemy which bindings, DOs, and migrations to send. The stack doesn't re-declare them.

## Resources shared between stack and worker

Resource *declarations* the worker binds — the D1 database, the schema — live in a module both import, so there's one definition:

```ts
// apps/web/worker/infra/resources.ts
export const schema = Drizzle.Schema("phoenix-schema", {
  schema: "../db/drizzle/schema.ts",
  out: "../db/drizzle/migrations",
});

export const PhoenixDb = Cloudflare.D1Database("phoenix_db", {migrationsDir: schema.out});
```

The worker `bind()`s `PhoenixDb` ([alchemy-bindings.md](./alchemy-bindings.md)); the stack ensures it (and the schema) exist before the worker deploys. The Durable Objects (`ConnectionDO`, `TopicDO`) are the `DurableObjectNamespace` classes themselves — declaring them and binding them in the worker is enough; alchemy derives the `new_sqlite_classes` migrations.

## What `wrangler.jsonc` keys become

| `wrangler.jsonc` | alchemy |
|---|---|
| `name`, `main`, `compatibility_*` | `Cloudflare.Worker` id + props ([alchemy-worker.md](./alchemy-worker.md)) |
| `assets` | the `assets` prop on the worker |
| `d1_databases` | `Cloudflare.D1Database(...)` resource |
| `durable_objects.bindings` | `Cloudflare.DurableObjectNamespace` declarations |
| `migrations` (DO classes) | derived from the DO declarations |
| `d1 migrations_dir` | `Drizzle.Schema` + `D1Database({migrationsDir})` ([alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md)) |
| `vars` | resource props / `Layer.succeed` config |

## Dev & deploy

```bash
alchemy dev       # local worker (Vite for the SPA + the worker runtime), live bindings
alchemy deploy    # build, bundle, push to the Cloudflare API
alchemy deploy --stage prod
```

`alchemy dev` supersedes `wrangler dev`; the SPA build still runs through Vite. The fate codegen Vite plugin is unaffected — it reads the server's exported `Entity<>` types at build time regardless of how the worker is deployed (see [fate-server-wiring.md](./fate-server-wiring.md)).

> **Stages give isolated environments per branch/PR.** `--stage <name>` deploys an independent copy of the stack (its own DOs, its own D1). This is how preview deploys work without a second config file — the stage name is threaded into resource names. `alchemy.run.ts` can branch on `stage` (e.g. reference a shared staging D1 for `pr-*` stages) the way the alchemy Neon examples do.

> **Tooling note.** alchemy's own examples run under `bun`; phoenix runs under `pnpm` + node. alchemy is plain TypeScript, so `pnpm alchemy deploy` / a node-run entry works — but confirm the CLI invocation and `package.json` scripts when wiring this up, and keep `wrangler` available until the alchemy deploy path is proven against the real account.

## See also

- [alchemy-worker.md](./alchemy-worker.md) — the worker this stack deploys
- [alchemy-bindings.md](./alchemy-bindings.md) — how the worker binds the resources declared here
- [alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md) — `Drizzle.Schema` + D1 migrations
- [alchemy-overview.md](./alchemy-overview.md) — what this replaces and why
