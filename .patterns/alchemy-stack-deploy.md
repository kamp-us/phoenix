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
pnpm build        # vite build → dist/client (the SPA assets the worker serves)
alchemy deploy    # bundle the worker, upload dist/client, push to the Cloudflare API
alchemy deploy --stage prod
```

The SPA is built by Vite as a normal build step (`dist/client`), then uploaded via the worker's `assets` prop — `alchemy deploy` does not drive Vite for phoenix's single-worker shape ([alchemy-worker.md](./alchemy-worker.md) explains why it's `Cloudflare.Worker` + `assets`, not `Cloudflare.Vite`). Drop `@cloudflare/vite-plugin` from `vite.config.ts` (alchemy is incompatible with it); keep `react()` and the `fate()` codegen plugin, which reads the server's `Entity<>` types regardless of deploy path (see [fate-server-wiring.md](./fate-server-wiring.md)).

### Local dev — two processes (the decided model)

phoenix's dev loop is **`vite dev` for the SPA (HMR) + `alchemy dev` for the worker, with Vite proxying the API**. This is a deliberate choice, not a workaround — here's the constraint that forces it:

alchemy has **two non-mixable worker runtime paths**. The Effect-native path (`Cloudflare.Worker` + `bind()` + the Effect DO model — what phoenix uses) runs under `alchemy dev`'s own local workerd runtime: it watch-rebuilds the *backend* on change but serves `dist/client` **statically, with no client HMR**. Integrated HMR exists only on the *other* path — `Cloudflare.Vite` driving `@distilled.cloud/cloudflare-vite-plugin` (alchemy's own fork) — but that path's worker entry is a plain `export default {fetch}`, so it **can't host phoenix's Effect-native worker**. You can't get `bind()`/Effect-DOs *and* integrated HMR on one worker.

> **Don't try to "fix" this by adding a Vite plugin to the Effect-native worker.** The reason there's no single-process HMR isn't a missing config — it's the two-path split above. `@distilled.cloud/cloudflare-vite-plugin` only runs the `Cloudflare.Vite` (plain-handler) path. phoenix chose the Effect-native worker and takes the two-process dev loop as the price.

So `alchemy dev` runs the one worker (live D1/DO bindings, backend watch-rebuild), and Vite serves the SPA with HMR and proxies the API to it. `alchemy dev` serves the worker **vhost-routed** at `http://<worker-name>.localhost:1337` — and since Node can't resolve `*.localhost`, the Vite proxy must target the IP and force the `Host` header (a `target: "http://<name>.localhost:1337"` fails with `ENOTFOUND`):

```ts
// vite.config.ts — dev only; alchemy owns deploy
const worker = {
  target: "http://127.0.0.1:1337",        // alchemy dev's local proxy port
  changeOrigin: false,
  headers: {host: "phoenix.localhost"},   // route to the worker by its vhost name
};
server: {proxy: {"/api": worker, "/fate": worker}}; // /fate/live SSE streams through fine
```

```bash
alchemy dev     # one worker + DOs + D1, vhost at http://phoenix.localhost:1337 (requires CF auth — alchemy login)
pnpm vite dev   # SPA + HMR + the fate() codegen plugin; proxies /api, /fate → the worker
```

> **Verified by a working spike** (alchemy `2.0.0-beta.44`, effect `4.0.0-beta.70`). Confirmed end-to-end in a browser: `alchemy dev` runs an Effect-native `Cloudflare.Worker`; an SSE stream (`HttpServerResponse.stream`) flows through the Vite proxy live; and **editing a React component does not drop the SSE connection** (the stream ran unbroken across edits — good for live views). Three gotchas it surfaced, now baked in above: (1) `alchemy dev` **requires Cloudflare auth** (`alchemy login` or `CLOUDFLARE_API_TOKEN`) — it is *not* offline; (2) the `127.0.0.1` + `Host` proxy shape is mandatory (`*.localhost` is unresolvable in Node); (3) install peers are non-obvious — `effect@beta` (v4; npm `latest` is v3), `@effect/platform-node`, `@effect/platform-bun`. One unresolved-but-orthogonal item: on bleeding-edge Vite 8-beta + plugin-react 6 + React 19, the POC showed a Fast Refresh *render-apply* quirk (update fired, state preserved, JSX didn't swap until a manual reload) — a Vite/React-plugin detail independent of alchemy (Vite dev runs standalone); validate against the real app's plugin versions.

It stays **one worker** — the second terminal is just the Vite dev server (not a worker); at deploy `vite build` produces `dist/client` and the single worker serves it. React HMR comes from `vite dev`, backend hot-reload from `alchemy dev`, so the full loop is live. A simpler one-terminal fallback is `alchemy dev` + `vite build --watch` (the static asset server picks up rebuilt `dist/client` on full reload, no HMR).

> **Two honest costs vs today's `@cloudflare/vite-plugin`.** (1) Two terminals instead of one command. (2) In dev the SPA is served by `vite dev` and routes to the worker through the Vite proxy, so dev routing is proxy rules rather than the prod `runWorkerFirst`/`assets` precedence — a dev/prod fidelity gap to keep in mind when debugging routing. Both are accepted tradeoffs of the Effect-native single-worker choice, not blockers.

> **Stages give isolated environments per branch/PR.** `--stage <name>` deploys an independent copy of the stack (its own DOs, its own D1). This is how preview deploys work without a second config file — the stage name is threaded into resource names. `alchemy.run.ts` can branch on `stage` (e.g. reference a shared staging D1 for `pr-*` stages) the way the alchemy Neon examples do.

> **Tooling note.** alchemy's own examples run under `bun`; phoenix runs under `pnpm` + node. alchemy is plain TypeScript, so `pnpm alchemy deploy` / a node-run entry works — but confirm the CLI invocation and `package.json` scripts when wiring this up, and keep `wrangler` available until the alchemy deploy path is proven against the real account.

## See also

- [alchemy-worker.md](./alchemy-worker.md) — the worker this stack deploys
- [alchemy-bindings.md](./alchemy-bindings.md) — how the worker binds the resources declared here
- [alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md) — `Drizzle.Schema` + D1 migrations
- [alchemy-overview.md](./alchemy-overview.md) — what this replaces and why
