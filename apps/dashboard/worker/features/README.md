# worker/features

App-level feature groupings (ADR 0036). Each feature owns its own slice —
domain logic, services, and (if it serves HTTP) a `route.ts` that `http/app.ts`
merges into the router.

Empty in the scaffold (#251): the dashboard's features — GitHub pipeline data
fetching, caching, the real UI's backing endpoints — arrive with the API
children (#252, #254, #255, #256). See `apps/web/worker/features/` for the shape
to mirror (`fate/`, `fate-live/`, `pasaport/`).
