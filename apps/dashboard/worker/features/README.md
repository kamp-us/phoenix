# worker/features

App-level feature groupings (ADR 0036). Each feature owns its own slice —
domain logic, services, and (if it serves HTTP) a `route.ts` that `http/app.ts`
merges into the router.

Features:

- **`pipeline/`** (#252) — the pipeline-state API. Fetches `kamp-us/phoenix`
  issues via the GitHub REST API and parses each issue's `status:*`/`type:*`/`p*`
  labels, the epic→children `sub_issues` relation, and the epic body's
  `## Dependencies` topology into structured JSON at `GET /api/pipeline`. The pure
  parse core (`parse.ts`) is separated from the GitHub fetch seam (`github.ts`) so
  it is unit-testable without the network; the response is validated with
  `effect/Schema` (`schema.ts`).

Still to come: caching (#254), the real UI's backing endpoints (#255, #256). See
`apps/web/worker/features/` for the broader shape (`fate/`, `fate-live/`,
`pasaport/`).
