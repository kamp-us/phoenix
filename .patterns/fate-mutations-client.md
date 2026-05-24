# Mutations (client)

How the SPA writes data. The short answer: call `fate.mutations.<entity.verb>({input, view, optimistic, insert})`. The response is written back into the normalized cache by its `view`, optimistic updates apply instantly and roll back on error, and connection membership is declarative (`insert`/`delete`) — there are no imperative cache updaters.

## Calling a mutation

```tsx
import {client as fate} from "../fate/client";

const result = await fate.mutations.definition.add({
  input: {termSlug, body},
  view: DefinitionView,            // the response shape, written into the cache
});
if (result.error) showError(result.error.code);
```

- `input` is the mutation payload; `view` is the selection of the returned entity. The returned entity is normalized into the cache, so every `useView` reading it re-renders.
- The call returns `{result, error}` — `error` is set for inline (`callSite`) failures (below).

For form submissions, `fate.actions.<entity.verb>` plugs into React 19's `useActionState`:

```tsx
const [state, submit, pending] = useActionState(fate.actions.definition.add, null);
// <form action={() => submit({input, view: DefinitionView})}>
```

Dispatch mutations inside `startTransition` (or via `useActionState`, which does this) so the UI stays responsive.

## Optimistic updates

Pass `optimistic` — a partial of the entity — and fate writes it to the cache immediately, then reconciles with the server response (or **rolls back** on error):

```tsx
fate.mutations.post.vote({
  input: {id: post.id, direction: "up"},
  optimistic: {score: post.score + 1, myVote: "up"},
  view: PostView,
});
```

For inserts that create an entity, give the optimistic record a temporary id (`optimistic:${Date.now()}`); fate reconciles it to the server id when the real result arrives. Concurrent optimistic edits to the same entity are masked so a slow server read can't clobber a still-pending field.

## Connection membership — declarative, not imperative

A new or deleted entity joins or leaves lists declaratively:

```tsx
// add to the front of every registered list of this type
fate.mutations.post.submit({input, view: PostView, insert: "before"});

// remove from all lists referencing it
fate.mutations.comment.delete({input: {id}, delete: true});
```

- `insert: "before" | "after" | "none"` (default `"after"`) inserts the entity into the **registered root lists** for its type (e.g. the post feed).
- `delete: true` prunes the entity and every reference to it across all connections.

There is no hand-written updater enumerating connection keys. For connections that aren't root lists (a post's comments, a filtered feed variant), **membership is driven by server-emitted live events** — the mutation publishes `live.connection(...).appendNode/deleteEdge(...)` and every subscribed client updates. See [fate-live-views.md](./fate-live-views.md). This replaces per-call imperative cache surgery with one server-side source of truth.

## Errors {#errors}

A failure is a `FateRequestError` with a `code` (`UNAUTHORIZED`, `VALIDATION_ERROR`, and the domain codes from `src/lib/mutationErrorCodes.ts`) and `message`. fate routes it by HTTP status:

- **`callSite`** (4xx — validation, conflict, not-found): returned as `result.error`. Render it inline next to the form/button. The like button reads `result?.error`, a form shows the field error.
- **`boundary`** (401/403/5xx): re-thrown, caught by the screen's error boundary ([fate-client-setup.md](./fate-client-setup.md)).

UI keys off `error.code`, never the message string — the codes are the shared contract with the server's `encodeFateError` ([fate-effect-bridge.md](./fate-effect-bridge.md)).

## See also

- [fate-views-and-requests.md](./fate-views-and-requests.md) — the views mutations write back through
- [fate-client-setup.md](./fate-client-setup.md) — the client + error boundary
- [fate-live-views.md](./fate-live-views.md) — server live events that drive connection membership
- [fate-mutations.md](./fate-mutations.md) — the server side of these mutations
- void reference (in the [fate](https://github.com/usirin/fate) repo): `src/ui/PostCard.tsx`, `src/ui/CreatePost.tsx`
