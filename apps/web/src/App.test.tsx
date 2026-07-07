/**
 * Regression pins for the two load-bearing first-paint invariants PR #2176 (fix for
 * #2160) established, so the review gate catches a regression mechanically instead of
 * a reviewer re-deriving it (#2177). Both invariants guard previously-real, user-visible
 * bugs:
 *
 *   (1) The static `Layout` shell paints FATE-FREE, above the session gate — the chrome
 *       (AppShell/Topbar/Footer, brand/nav/search, the giriş-yap/+gönderi auth split)
 *       renders on the first frame while the session is `isPending`, with NO `FateClient`
 *       mounted, so there is no blank first-paint flash (#2160). The fate-consuming hooks
 *       live in `LayoutContent`, BELOW the `FateProvider` gate.
 *   (2) `FateClient` mounts ONCE on the resolved identity — no anon→id remount. Because
 *       `FateProvider`'s `if (session.isPending) return null` defers the first commit, the
 *       first (and only) `key={userId ?? "anon"}` is the settled identity, so the router
 *       subtree is never remounted across session settle (which would wipe controlled-form
 *       state — the #438 bug).
 *
 * Both are pinned by rendering the REAL `App` (its real `Layout`, real `FateProvider`,
 * real `SetTopbarChipsContext` bridge) and observing the REAL `FateProvider` gate logic
 * through a mount-recording `FateClient` spy. A regression that reaches a fate/session
 * read back into the shell (invariant 1) or re-keys `FateClient` anon→id (invariant 2)
 * fails these — see the two `// REGRESSION:` notes on the assertions.
 *
 * The third block pins the two-tier fate provider (ADR 0167 / #2285): the /pano feed
 * paints over the PUBLIC client above the gate while `get-session` is pending, then hands
 * off to the authed tier once it commits — WITHOUT dragging the authed router subtree
 * through the anon→id re-key remount invariant 2 forbids. The spy tags each mount
 * public/authed so the two tiers are told apart.
 */
import {act, render, screen} from "@testing-library/react";
import type {ReactNode} from "react";
import {MemoryRouter} from "react-router";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {App} from "./App";

// The two-tier public client (ADR 0167 / #2285): the eager public tier passes this
// sentinel as its `FateClient` `client`, so the spy can tag a mount as `public` (the
// always-anonymous tier above the gate) vs `authed` (the identity-keyed tier below it).
const {PUBLIC_CLIENT} = vi.hoisted(() => ({PUBLIC_CLIENT: {__tier: "public"} as never}));

// The mounts the two-tier fate provider commits, in order. Each entry is one `FateClient`
// mount: its `key` (the identity it committed under) and its `tier` (public/authed).
// Invariant 2 / #438 reads the AUTHED tier back: one entry keyed on the resolved identity
// is correct; a second entry (or a leading "anon" entry) is the anon→id remount.
type FateMount = {key: string; tier: "public" | "authed"};
const fateMounts: FateMount[] = [];

// Spy `FateClient` in place of react-fate's real one, driving the REAL `FateProvider`
// (its real `if (session.isPending) return null` gate + real `key={userId ?? "anon"}`).
// React consumes `key` itself and never forwards it as a readable prop, so instead of
// reading the key the spy records, ON MOUNT, the session identity live from the same
// source the real FateProvider keys on — the mocked `useSession`. React remounts the spy
// exactly when the committed `key` changes, so one recorded mount == one real key, and a
// second recorded mount is exactly the anon→id remount invariant 2 forbids. Recording on
// MOUNT (an empty-dep effect), not per render, is what makes a remount observable. The
// `tier` is read off the `client` instance — the public tier passes `PUBLIC_CLIENT`.
vi.mock("react-fate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-fate")>();
	const {useEffect} = await import("react");
	const {useSession} = await import("./auth/client");
	function FateClientSpy({children, client}: {children: ReactNode; client: unknown}) {
		const session = useSession();
		const key = session.data?.user.id ?? "anon";
		const tier = client === PUBLIC_CLIENT ? "public" : "authed";
		useEffect(() => {
			// Empty deps: fires once per real mount. A re-key (anon→id) tears this instance
			// down and mounts a fresh one, firing this again — the double-mount we're pinning.
			fateMounts.push({key, tier});
		}, []);
		return <>{children}</>;
	}
	return {...actual, FateClient: FateClientSpy};
});

// The eager public pano feed (ADR 0167) renders the REAL `PanoFeed` over the public
// client; stub it inert here so the tree renders offline without a real fate context —
// its PRESENCE above the gate (the `eager-pano-feed` marker) is what the two-tier tests
// assert, not its internal fate reads.
vi.mock("./pages/PanoFeed", () => ({
	PanoFeed: ({host}: {host?: string}) => <div data-testid="eager-pano-feed">{host ?? "all"}</div>,
}));

// The public tier's client factory — return the sentinel the spy tags as `public`.
vi.mock("./fate/publicClient", () => ({getPublicFateClient: () => PUBLIC_CLIENT}));

// Controllable, REACTIVE session store. The whole first-paint story is "shell paints
// while pending, FateProvider commits once settled", so the mock must actually trigger a
// re-render when the test settles the session — a plain mutated variable wouldn't, and
// FateProvider would never re-run its gate. `useSyncExternalStore` gives every
// `useSession` consumer a real subscription; `setSession` (wrapped in `act` by the test)
// notifies them, so the pending→resolved transition drives the real React commit path.
type SessionState = {
	data: {user: {id: string; name: string; email: string}} | null;
	isPending: boolean;
};
let sessionState: SessionState = {data: null, isPending: true};
const sessionListeners = new Set<() => void>();
const setSession = (next: SessionState) => {
	sessionState = next;
	for (const notify of [...sessionListeners]) notify();
};
vi.mock("./auth/client", async () => {
	const {useSyncExternalStore} = await import("react");
	return {
		useSession: () =>
			useSyncExternalStore(
				(onChange) => {
					sessionListeners.add(onChange);
					return () => sessionListeners.delete(onChange);
				},
				() => sessionState,
			),
		authClient: {signOut: vi.fn(async () => undefined)},
		clearBearerToken: vi.fn(),
	};
});

// Keep the REAL FateProvider under test (its gate + key are invariant 2), but stub its
// two network-touching collaborators so it runs offline: the client factory (which would
// build an HTTP/EventSource transport) and the global live pin (which resolves
// `useFateClient` from the real context the spied FateClient doesn't provide).
vi.mock("./fate/client", () => ({createClient: () => ({}) as never}));
vi.mock("./fate/useGlobalLivePin", () => ({useGlobalLivePin: () => undefined}));

// The fate-consuming hooks that live BELOW the gate in `LayoutContent`. Stub them inert
// so `LayoutContent` renders offline once the gate commits — their PRESENCE below the
// gate is invariant 1's point; here they must simply not touch the wire.
vi.mock("./auth/useMe", () => ({
	useMe: () => ({me: null, status: "idle", loading: false, refetch: vi.fn()}),
}));
vi.mock("./pages/useProfileStats", () => ({useProfileStats: () => ({status: "idle"})}));
vi.mock("./components/divan/useDivanAccess", () => ({useDivanAccess: () => false}));
vi.mock("./components/bildirim/useBildirimUnread", () => ({useBildirimUnread: () => 0}));

// Controllable flag mock. The eager `/profile` Katkıların skeleton (#2188) is gated on
// the authorship-loop flag, so its tests flip `flags.authorshipLoop`; every other read
// (and other flag key) stays off, matching the default the shell rendered under before.
const flags = vi.hoisted(() => ({authorshipLoop: false}));
vi.mock("./flags/useFlag", async () => {
	const {PHOENIX_AUTHORSHIP_LOOP} = await import("./flags/keys");
	return {
		useFlag: (key: string) => ({
			value: key === PHOENIX_AUTHORSHIP_LOOP ? flags.authorshipLoop : false,
			loading: false,
		}),
	};
});

// Render the real App at a chosen route. Invariant 2's tests settle the session, which
// commits FateProvider and mounts the routed page BELOW it — so they route to a
// fate-free page (`*` → NotFoundPage) whose render doesn't reach into the spied
// FateClient's (absent) real context. Invariant 1's tests never settle (FateProvider
// stays `null`), so the routed Outlet never mounts and the route is immaterial there.
function renderApp(route = "/") {
	return render(
		<MemoryRouter initialEntries={[route]}>
			<App />
		</MemoryRouter>,
	);
}
// A route that resolves to the fate-free NotFoundPage (`*`), for the post-settle tests.
const FATE_FREE_ROUTE = "/__no_such_route__";

describe("App first-paint invariants (#2177 — pins #2160 flash + #438 remount)", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("invariant 1: the shell chrome paints while the session is isPending — with NO FateClient mounted", () => {
		// First frame: session unresolved (isPending), before any fate client commits.
		renderApp();

		// The static shell chrome renders — no blank, no crash (#2160). Brand, nav, search,
		// and the anonymous auth affordance are all present on the fate-free first paint.
		expect(screen.getByRole("link", {name: /kamp/i})).toBeTruthy();
		expect(screen.getByRole("link", {name: "sözlük"})).toBeTruthy();
		expect(screen.getByRole("link", {name: "pano"})).toBeTruthy();
		expect(screen.getByLabelText("Ara")).toBeTruthy();
		// The auth split rides `useSession` alone (correct immediately, no fate): signed-out
		// shows "giriş yap", never the signed-in "+ gönderi".
		expect(screen.getByRole("button", {name: "giriş yap"})).toBeTruthy();
		expect(screen.queryByRole("button", {name: "+ gönderi"})).toBeNull();

		// REGRESSION: the fate-free proof. FateProvider's `if (session.isPending) return null`
		// means NO FateClient has committed on the pending first frame — so the shell painted
		// with zero fate mounts. A refactor that lifts a fate-dependent read back into the
		// shell (above the gate) would mount a FateClient here (or crash on a missing fate
		// context), failing this assertion.
		expect(fateMounts).toHaveLength(0);
	});

	it("invariant 1 (bridge): the SetTopbarChipsContext bridge shows anonymous affordances pre-settle — chips=null is not a blank frame", () => {
		renderApp();
		// The topbar chip props default to null pre-settle; the frame still paints its full
		// anonymous chrome rather than a blank/absent topbar. The signed-out affordance is the
		// observable proof the chip bridge degrades to anonymous, not empty.
		expect(screen.getByRole("button", {name: "giriş yap"})).toBeTruthy();
		expect(screen.getByRole("link", {name: /kamp/i})).toBeTruthy();
		// Still fate-free at this point — chips arrive only after FateProvider commits below.
		expect(fateMounts).toHaveLength(0);
	});

	it("invariant 2: FateClient mounts ONCE on the resolved identity — no anon→id remount (#438)", () => {
		renderApp(FATE_FREE_ROUTE);
		// Pending first paint → the gate defers, no mount yet.
		expect(fateMounts).toHaveLength(0);

		// The session settles to an authenticated identity. FateProvider commits for the
		// first time NOW, under the resolved user id — never under "anon" first.
		act(() => {
			setSession({
				data: {user: {id: "user-42", name: "Elif", email: "elif@kamp.us"}},
				isPending: false,
			});
		});

		// Exactly ONE mount, and its key is the resolved id — not "anon". This is the #438
		// guard: had FateProvider committed under isPending, we'd see a first mount keyed
		// "anon" then a SECOND mount keyed "user-42" (the remount that wipes controlled-form
		// state).
		expect(fateMounts).toHaveLength(1);
		expect(fateMounts[0]?.key).toBe("user-42");
		// REGRESSION: no anon→id re-key. If the `if (session.isPending) return null` gate were
		// removed (committing under anon first), fateMounts would be [{key:"anon"},{key:"user-42"}]
		// — length 2, first key "anon" — and all three assertions here fail.
		expect(fateMounts.map((m) => m.key)).not.toContain("anon");
	});

	it("invariant 2 (anonymous settle): a session that settles signed-out mounts ONCE under 'anon' — still no double-mount", () => {
		renderApp(FATE_FREE_ROUTE);
		expect(fateMounts).toHaveLength(0);

		// Settles with no user (signed-out but resolved). The gate commits once, keyed "anon"
		// — but only once, because the pending frame committed nothing.
		act(() => {
			setSession({data: null, isPending: false});
		});

		expect(fateMounts).toHaveLength(1);
		expect(fateMounts[0]?.key).toBe("anon");
	});
});

// The two-tier fate provider's public first paint (ADR 0167 / #2285): the anon-capable
// /pano feed paints over the PUBLIC (always-anonymous) client ABOVE the session gate,
// in parallel with `get-session`, then hands off to the authed feed once the gate
// commits — WITHOUT an anon→id re-key remount of the authed router subtree (#438).
describe("Two-tier fate provider — /pano public first paint (#2285)", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("AC2/AC5: the /pano feed paints over the public client while the session is isPending — before the authed gate commits", () => {
		// First frame on /pano: session still resolving. The authed FateProvider gate is
		// null, yet the public feed paints — proof the first paint does NOT wait on
		// get-session.
		renderApp("/pano");

		expect(screen.getByTestId("eager-pano-feed")).toBeTruthy();
		// It painted over the PUBLIC tier (above the gate)…
		expect(fateMounts.some((m) => m.tier === "public")).toBe(true);
		// …while the AUTHED tier has NOT committed (still isPending → null below).
		expect(fateMounts.some((m) => m.tier === "authed")).toBe(false);
	});

	it("scoped: a non-pano route paints NO public feed (the eager tier is /pano-only)", () => {
		renderApp("/sozluk");
		expect(screen.queryByTestId("eager-pano-feed")).toBeNull();
		// No public client mounts off the pano routes — the shell stays fate-free there.
		expect(fateMounts).toHaveLength(0);
	});

	it("AC4 (#438): after the public first paint, the authed subtree mounts ONCE on the resolved id — no anon→id remount", () => {
		renderApp("/pano");
		// Pending: only the public tier has painted; the authed gate is still deferred.
		expect(fateMounts.filter((m) => m.tier === "authed")).toHaveLength(0);

		// The session settles authenticated → the authed FateProvider commits for the
		// FIRST time now, under the resolved id — the eager public tier unmounts.
		act(() => {
			setSession({
				data: {user: {id: "user-7", name: "Deniz", email: "deniz@kamp.us"}},
				isPending: false,
			});
		});

		const authed = fateMounts.filter((m) => m.tier === "authed");
		// Exactly ONE authed mount, keyed on the resolved id — never "anon" first. Had the
		// public first paint dragged the authed tree through an anon→id re-key, we'd see a
		// leading {key:"anon"} authed mount (the #438 form-wiping remount).
		expect(authed).toHaveLength(1);
		expect(authed[0]?.key).toBe("user-7");
		expect(authed.map((m) => m.key)).not.toContain("anon");
	});
});

// The two-tier decoupling extended to /profile (ADR 0167 / #2188): the identity-scoped
// Katkıların read can't paint anon data pre-session, so /profile's eager tier paints a
// SKELETON above the gate while `get-session` resolves, then the authed read below the
// gate fills it in. Unlike /pano's tier it mounts NO FateClient — which is exactly what
// keeps #438 preserved (no client above the gate ⇒ nothing to re-key anon→id).
describe("Two-tier fate provider — /profile eager Katkıların skeleton (#2188)", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
		flags.authorshipLoop = true;
	});
	afterEach(() => {
		flags.authorshipLoop = false;
		vi.clearAllMocks();
	});

	it("paints the Katkıların skeleton on /profile while the session isPending — before the authed gate commits", () => {
		renderApp("/profile");

		expect(screen.getByTestId("signal-loading")).toBeTruthy();
		// It painted ABOVE the gate with NO FateClient committed — the authed tier is
		// still deferred (isPending → null), and the eager tier mounts no client at all.
		expect(fateMounts).toHaveLength(0);
	});

	it("#438: the eager /profile skeleton mounts NO FateClient — nothing to re-key anon→id", () => {
		renderApp("/profile");
		// The proof the eager tier can't reintroduce the #438 remount: it commits zero
		// fate clients above the gate, so there is no anon-keyed client to later re-key to
		// the resolved id. The authed FateProvider below is untouched (its once-on-settle
		// mount is pinned by the invariant-2 tests above).
		expect(fateMounts).toHaveLength(0);
		expect(screen.getByTestId("signal-loading")).toBeTruthy();
	});

	it("scoped: a non-profile route paints NO eager Katkıların skeleton", () => {
		renderApp("/sozluk");
		expect(screen.queryByTestId("signal-loading")).toBeNull();
		expect(fateMounts).toHaveLength(0);
	});

	it("flag-off: /profile paints NO eager skeleton — no flash of a section the settled page won't render", () => {
		flags.authorshipLoop = false;
		renderApp("/profile");
		expect(screen.queryByTestId("signal-loading")).toBeNull();
		expect(fateMounts).toHaveLength(0);
	});
});

// The header search box echoes the active query on the results page (#2199). The
// box lives in the fate-free shell, so these render without settling the session.
describe("Topbar search echo (#2199)", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("echoes the URL q in the header search input on /search", () => {
		renderApp("/search?q=elma");
		expect((screen.getByLabelText("Ara") as HTMLInputElement).value).toBe("elma");
	});

	it("reads q live — a different query renders a different echoed value (no stale/double source)", () => {
		renderApp("/search?q=armut");
		expect((screen.getByLabelText("Ara") as HTMLInputElement).value).toBe("armut");
	});

	it("leaves the header input empty off the results page (unchanged behavior)", () => {
		renderApp("/pano");
		expect((screen.getByLabelText("Ara") as HTMLInputElement).value).toBe("");
	});
});
