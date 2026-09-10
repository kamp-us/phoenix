# Web

This app owns the public worker, SPA and API. HTTP uses Effect; fate serves data at
`/fate` and live updates at `/fate/live`. Other backend routes belong under `/api/*`.
One `LiveDO` class owns the connection and topic roles. Feature services are built
at worker initialization; validated request identity is provided per request.

- Keep `CurrentUser`, `CurrentActor` and live publication tied to the validated
  request. `Auth` names the BetterAuth instance type, not a session service.
- Every authenticated request revalidates its session. Bans, deletion, logout and
  revocation must take effect immediately. Do not add session caching;
  [ADR 0169](../../.decisions/0169-no-session-caching-immediate-teardown-invariant.md)
  owns that constraint.
- A write must preserve the author's capability and content-visibility rules.
  A mutation over a live-subscribed `Post`, `Comment` or `Definition` must publish
  its invalidation after the write through `WorkerLivePublisher`. Classify every
  mutation in [fanned-mutations.ts](worker/features/fate-live/fanned-mutations.ts).
- All user copy comes from the typed [i18n catalog](src/i18n/), in Turkish and
  English, with Turkish the default. Keep exceptions explicit in the existing
  guard configuration; a clean literal scan is not proof that all copy is localized.
- Rendered UI follows the root design manifest. Use existing shared components
  and role tokens. New behavior follows the feature-flag release rules; `/lab/*`
  is public, including in production, and still requires authorization for writes.
- Unit tests substitute storage. Claims about real D1, worker HTTP or live fan-out
  belong in the web integration tier. An in-memory SQL engine is not a D1 substitute.
- This app's stack owns deployment. Before starting development or changing bindings,
  read the [current setup](../../DEVELOPMENT.md#quickstart) and local binding
  instructions in [.env.example](.env.example). Local state does
  not mean remote resources are absent; preserve the stack's resource ownership.
- Never rebuild a runtime content-seeding route on the public worker. The deleted
  `/api/admin/*` seeders were unsafe. Cold-start content import is a v1 non-goal;
  founders write as users, and new authors arrive through vouching and moderation.

Use the shared [pattern index](../../.patterns/index.md) for the implementation
guidance relevant to this change.
