# The flag-dark page gate

**The shape a flag-dark page gate takes**: the route ships behind a default-off flag, self-404s while
the flag is off, and never decides 404-vs-page until the flag has actually resolved. Reach for this doc
before adding a page-level `useFlag` gate; the flag system itself (declaring, flipping, reading
server-side) is [feature-flags.md](./feature-flags.md), and where the route mounts is
[frontend-routing.md](./frontend-routing.md).

## The three rules

1. **Dark by default.** The gate reads `useFlag(KEY, false)`. The flag's declared default is `off`,
   so the page is unreachable the moment it merges and a human flips it on later (ADR
   [0083](../.decisions/0083-agents-deploy-humans-release.md)).
2. **Off ⇒ 404, from the page itself.** With the flag off the component returns `<NotFoundPage />`.
   The route stays mounted in `App.tsx` either way — the page owns its own visibility, so there is
   no conditional route tree to keep in sync.
3. **Defer the decision while the flag is loading.** Render a neutral placeholder until `loading` is
   false. Deciding on the default value would show a 404 for one paint to a user who is entitled to
   the page, then swap it for the page — which reads as a broken link, not as loading.

## The shape

```tsx
export function MutesPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(MEMBER_MUTE, false);
	const session = useSession();

	// The deferred-404 gate — see `.patterns/flag-dark-page-gate.md`.
	if (flagLoading || session.isPending) {
		return (
			<div className="kp-mutes">
				<div className="kp-mutes__inner">
					<p className="kp-mutes__loading">yükleniyor…</p>
				</div>
			</div>
		);
	}

	if (!flagOn) return <NotFoundPage />;
	// …the page
}
```

Every asynchronous input the 404 decision depends on joins the same first branch —
`session.isPending` above, because a signed-out visitor is redirected rather than 404'd and that
answer is not known yet either. The placeholder wears the page's own frame (its container classes,
its `yükleniyor…` line), so releasing the page is not a layout jump; see
[fate-async-react.md](./fate-async-react.md) for the height-matching discipline.

Once the gate needs more than two conditions, lift the state choice into a pure function beside the
page and test it there — `caylakVisibilityGating.ts` returns one of six states (`loading`, `404`,
`auth`, …) and `CaylakVisibilityPage` only renders what it names.

## The `useFlag(key, default)` contract the gate reads

`useFlag` returns `{value, loading}` ([`apps/web/src/flags/useFlag.ts`](../apps/web/src/flags/useFlag.ts)):

- `value` is `default` until the server resolves a genuine boolean. The read **never throws** — an
  unreachable Flagship, a typo'd key and a non-2xx response all hold the default, so a flag outage
  leaves every dark page 404ing rather than breaking.
- `loading` is the only thing that distinguishes "resolved to `false`" from "still `false` because
  nothing answered yet". Both look identical in `value`, which is exactly why the gate branches on
  `loading` first.

## The `__BOOT__` fast path

A key listed in `SHELL_FLAG_KEYS` ([`apps/web/src/flags/shell-keys.ts`](../apps/web/src/flags/shell-keys.ts))
is injected into `window.__BOOT__` by the worker's shell render, and `useFlag` resolves it
synchronously in its `useState` initializer — so the very first render already carries
`{value, loading: false}` and the placeholder branch never paints. `MECMUA_PUBLIC_READ` and
`MECMUA_FEED` are the members today, so `MecmuaIndexPage`, `MecmuaPostPage` and `MecmuaFeedPage` get
the fast path; every other gated page — including the `MECMUA_WRITE` pages `MecmuaDraftsPage` and
`MecmuaEditorPage` — takes the `/api/flags/evaluate` round trip and does paint the placeholder.

That does not make the placeholder branch dead code: `__BOOT__` is absent whenever the shell was not
injected, and membership is a deliberate, guarded decision — only a flag whose wrong value moves
geometry at first paint belongs there, and both sides derive the key set from the one manifest (ADR
[0179](../.decisions/0179-edge-resolved-shell-state-boot-contract.md)). Write the gate the same way
regardless of membership.

## When this is not the gate you want

- **Access that the server already decides.** `/divan` and `/funnel` carry no flag and no
  client-side role check: the fate root denies a non-reviewer `UNAUTHORIZED` and `<Screen>` renders
  "yetkin yok". A client gate over a server-authoritative answer is a second source of truth.
- **A flag that toggles something inside a live page.** `PanoFeed` reads `MEMBER_MUTE` for the mute
  affordance and `ProfilePage` reads `PHOENIX_CAYLAK_VISIBILITY` for a marker; neither blocks the
  page, so both read `value` alone and let the default hold through loading. Use `<FlagGate>` for
  the declarative version.

## Pages carrying the gate today

`BildirimlerPage`, `CaylakVisibilityPage`, `MecmuaDraftsPage`, `MecmuaEditorPage`,
`MecmuaFeedPage`, `MecmuaIndexPage`, `MecmuaPostPage`, `MutesPage` — all under
`apps/web/src/pages/`.
