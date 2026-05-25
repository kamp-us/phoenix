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

> **`insert`/`delete` only reach *root* lists; nested-connection membership is driven by server live events.** A root list is registered only when its connection has **no filter args** (`registerRootList` is gated on `!filterConnectionArgs(argsPayload)`). A *nested* connection (`Term.definitions` carried on the `term` query) is never a registered root list, so client-side `insert`/`delete` can't touch it — its membership comes from the mutation publishing `live.connection(...).appendNode/deleteEdge(...)` (pano's `comment.add`/`comment.delete` do this). Where a mutation doesn't publish an append, the screen reloads after success:
> - **add** to a nested connection: the new node is normalized into the cache, but joins the list only via a live `appendNode` or a re-read. sözlük's `definition.add` publishes no append, so its composer **reloads after a successful add**.
> - **delete** of a node in a nested connection: `delete: true` is **wrong-entity** for sözlük's `definition.delete`, a `Term`-returning mutation (it re-resolves the parent for fresh counts), so `delete:true` would `deleteRecord("Term", definitionId)`. The card calls delete **without** `delete:true`; the server publishes `deleteEdge("Definition", id)` on `Term.definitions`.
>
> Entity-field mutations (vote, edit) are unaffected: they write back through the result `view` and re-render in place, fully optimistic.

## Errors {#errors}

A failure is a `FateRequestError` with a `code` (`UNAUTHORIZED`, `VALIDATION_ERROR`, and the domain codes from `src/lib/mutationErrorCodes.ts`) and `message`. fate routes it by HTTP status:

- **`callSite`** (4xx — validation, conflict, not-found): returned as `result.error`. Render it inline next to the form/button. The like button reads `result?.error`, a form shows the field error.
- **`boundary`** (401/403/5xx): re-thrown, caught by the screen's error boundary ([fate-client-setup.md](./fate-client-setup.md)).

UI keys off `error.code`, never the message string — the codes are the shared contract with the server's `encodeFateError` ([fate-effect-bridge.md](./fate-effect-bridge.md)).

> **fate classifies phoenix's wider codes as `boundary` (so a mutation *throws* instead of returning `{error}`).** The client derives callSite-vs-boundary purely from the wire `code` → `statusFromErrorCode(code)`, whose `switch` knows only the 6 protocol codes (`BAD_REQUEST`/`VALIDATION_ERROR`→400, `UNAUTHORIZED`→401, `FORBIDDEN`→403, `NOT_FOUND`→404, `INTERNAL_ERROR`→500) with **no `default`**; phoenix codes (`BODY_REQUIRED`, `BODY_TOO_LONG`, `DEFINITION_NOT_FOUND`, `TAKEN`, …) resolve to `status: undefined` → `categorizeHTTPErrorStatus` falls to `boundary`. The per-op wire error drops `status` (only `{code,message,issues}`) and the client rebuilds it from `code`, so a phoenix code can't carry a 4xx through the wire. **The optimistic rollback still fires** (fate clears the optimistic write + restores snapshots *before* the throw). So phoenix mutation call sites **`try { const {error} = await fate.mutations… } catch (e) {}`**: handle both the `callSite` `{error}` return AND the `boundary` throw, read `.code` off either, and render inline (an async throw never reaches a React error boundary anyway). `UNAUTHORIZED` routes to the auth redirect. sözlük's `DefinitionCard` + term-page composer do this.

## See also

- [fate-views-and-requests.md](./fate-views-and-requests.md) — the views mutations write back through
- [fate-client-setup.md](./fate-client-setup.md) — the client + error boundary
- [fate-live-views.md](./fate-live-views.md) — server live events that drive connection membership
- [fate-mutations.md](./fate-mutations.md) — the server side of these mutations
- void reference (in the [fate](https://github.com/usirin/fate) repo): `src/ui/PostCard.tsx`, `src/ui/CreatePost.tsx`
