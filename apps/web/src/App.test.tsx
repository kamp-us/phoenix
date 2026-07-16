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

// Spy the authed-tier feed-snapshot seam (#2321) so the wiring is observable independent of
// the (default-off, `window`-bound) flag: FateProvider hydrates at client creation on the
// resolved id + installs persistence, and tears down the previous identity's snapshot on an
// identity change / sign-out; App's `onSignOut` tears down eagerly. The pure storage contract
// is proven in `snapshot.test.ts`; here we assert only that the seam CALLS teardown/hydrate.
const snapshotSpies = vi.hoisted(() => ({
	hydrateAuthedClient: vi.fn(),
	installAuthedSnapshotPersistence: vi.fn(() => () => {}),
	teardownAuthedSnapshot: vi.fn(),
}));
vi.mock("./fate/snapshot", () => snapshotSpies);

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
// the authorship-loop flag, so its tests flip `flags.authorshipLoop`; the mecmua feed
// (akış) nav entry (#2547) is gated on `mecmua-feed`, flipped via `flags.mecmuaFeed`.
// Every other read (and other flag key) stays off, matching the default the shell
// rendered under before.
// `signedIn` drives the mocked `readBootUser` (the `__BOOT__.user` edge identity, ADR 0185):
// the shell frame reads it to reserve AND seed the signed-in account cluster before `useSession`
// settles. Default false = `__BOOT__` absent, so the pre-existing shell tests see today's
// signed-out first paint unchanged.
const flags = vi.hoisted(() => ({
	authorshipLoop: false,
	mecmuaFeed: false,
	navIa: false,
	signedIn: false,
}));
vi.mock("./flags/useFlag", async () => {
	const {PHOENIX_AUTHORSHIP_LOOP, MECMUA_FEED, PHOENIX_NAV_IA} = await import("./flags/keys");
	return {
		useFlag: (key: string) => ({
			value:
				key === PHOENIX_AUTHORSHIP_LOOP
					? flags.authorshipLoop
					: key === MECMUA_FEED
						? flags.mecmuaFeed
						: key === PHOENIX_NAV_IA
							? flags.navIa
							: false,
			loading: false,
		}),
	};
});
// The edge-resolved `__BOOT__.user` (ADR 0185): when `flags.signedIn`, the shell reads the full
// identity synchronously — the account cluster paints its name (`Elif`) on the first frame, before
// the session settles. Absent (default) ⇒ null ⇒ the signed-out first paint. `importActual` keeps
// the real `readBoot`/`readBootMember`; only the user read is faked.
vi.mock("./flags/boot", async (importActual) => ({
	...(await importActual<typeof import("./flags/boot")>()),
	readBootUser: () =>
		flags.signedIn
			? {
					id: "user-42",
					email: "elif@kamp.us",
					name: "Elif",
					image: null,
					username: "elif",
					tier: "yazar" as const,
					isModerator: false,
					emailFailing: false,
				}
			: null,
}));

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

// Signed-in cluster seeded from __BOOT__.user (ADR 0185, superseding #2933's presence-only bit).
// The shell frame reads the edge identity at first paint: signed-in ⇒ no giriş-yap CTA and the
// account cluster's CONTENT (the name) rendered synchronously BEFORE useSession settles, so the
// giriş-yap↔user-cluster swap + the name content pop-in never happen; absent __BOOT__ ⇒
// readBootUser() null ⇒ today's session-gated render (the AC-3 no-op).
describe("signed-in cluster seeded from __BOOT__.user (ADR 0185)", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
		flags.signedIn = false;
	});
	afterEach(() => {
		flags.signedIn = false;
		vi.clearAllMocks();
	});

	it("__BOOT__ present + user: first paint renders the account name — no giriş-yap flash, before the session settles", () => {
		flags.signedIn = true;
		renderApp();
		// The session is still isPending (no fate, no chips), yet the shell already knows WHO is
		// signed in from the edge user object: the CTA is gone and the name renders synchronously.
		expect(screen.queryByRole("button", {name: "giriş yap"})).toBeNull();
		expect(screen.getByText("Elif")).toBeTruthy();
		expect(fateMounts).toHaveLength(0);
	});

	it("__BOOT__ present + user: no content swap when the session settles signed-in", () => {
		flags.signedIn = true;
		renderApp(FATE_FREE_ROUTE);
		// Pre-settle: the signed-in name is already painted, no CTA.
		expect(screen.queryByRole("button", {name: "giriş yap"})).toBeNull();
		expect(screen.getByText("Elif")).toBeTruthy();
		act(() => {
			setSession({
				data: {user: {id: "user-42", name: "Elif", email: "elif@kamp.us"}},
				isPending: false,
			});
		});
		// Settled signed-in: still no CTA and the same name — the account cluster held its content
		// across settle, never swapping giriş-yap in then out nor popping the name in (the jank).
		expect(screen.queryByRole("button", {name: "giriş yap"})).toBeNull();
		expect(screen.getByText("Elif")).toBeTruthy();
	});

	it("__BOOT__ absent (readBootUser null): the shell is exactly as today — giriş-yap, no account cluster (AC-3)", () => {
		renderApp();
		expect(screen.getByRole("button", {name: "giriş yap"})).toBeTruthy();
		expect(screen.queryByText("Elif")).toBeNull();
		expect(screen.queryByTestId("topbar-user-placeholder")).toBeNull();
	});
});

// The mecmua feed (akış) nav entry (#2547) gates on the SAME `mecmua-feed` seam the
// `/mecmua/akis` route self-gates on — so the link never points at a dark 404. These
// pin that gating: absent when the flag is off, present (→ /mecmua/akis) when it flips.
describe("mecmua feed nav entry (#2547) — gated on mecmua-feed, never a dead link", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
		flags.mecmuaFeed = false;
	});
	afterEach(() => {
		flags.mecmuaFeed = false;
		vi.clearAllMocks();
	});

	it("off: the flag dark ⇒ no akış nav link (subscribe's destination stays hidden with its route)", () => {
		renderApp();
		expect(screen.queryByRole("link", {name: "akış"})).toBeNull();
	});

	it("on: the flag flipped ⇒ the akış nav link paints and points at /mecmua/akis", () => {
		flags.mecmuaFeed = true;
		renderApp();
		const link = screen.getByRole("link", {name: "akış"});
		expect(link.getAttribute("href")).toBe("/mecmua/akis");
	});
});

// The nav-IA substrate (#2598, epic #2596): each product mounts under a nested layout
// route rendering a persistent product Subnav zone, gated on the default-off
// `phoenix-nav-ia` seam. Off ⇒ the router is flat, exactly as today (no product zone);
// on ⇒ the product route resolves under `ProductSubnavLayout`, which paints a `.kp-subnav`
// zone above the routed page. The routed page (mocked PanoFeed) mounts below the gate, so
// these settle the session (signed-out) to commit the routed Outlet.
describe("nav-IA per-product Subnav zone substrate (#2598)", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
		flags.navIa = false;
	});
	afterEach(() => {
		flags.navIa = false;
		vi.clearAllMocks();
	});

	it("flag off: the /pano route is flat — no product Subnav zone (the surface is exactly as before)", () => {
		const {container} = renderApp("/pano");
		act(() => {
			setSession({data: null, isPending: false});
		});
		expect(container.querySelector(".kp-subnav")).toBeNull();
	});

	it("flag on: the /pano route mounts under the product layout — a persistent Subnav zone paints above the page", () => {
		flags.navIa = true;
		const {container} = renderApp("/pano");
		act(() => {
			setSession({data: null, isPending: false});
		});
		expect(container.querySelector(".kp-subnav")).toBeTruthy();
	});

	it("flag on: a non-product route (/search) mounts NO product Subnav zone", () => {
		flags.navIa = true;
		const {container} = renderApp("/search");
		act(() => {
			setSession({data: null, isPending: false});
		});
		expect(container.querySelector(".kp-subnav")).toBeNull();
	});
});

// The atomic coupling (#2600, epic #2596): pano/yeni moves into the pano Subnav CTA slot
// AND the topbar `+ gönderi` button is evicted — both gated on the SAME `phoenix-nav-ia`
// seam so they release as one unit. Off ⇒ today's surface (topbar `+ gönderi`, no CTA);
// on ⇒ the CTA lives in pano's product zone and the topbar no longer carries it. The
// signed-out `giriş yap` affordance is untouched in either flag state.
const SIGNED_IN = {data: {user: {id: "u1", name: "Elif", email: "elif@kamp.us"}}, isPending: false};
describe("nav-IA coupling: pano/yeni Subnav CTA ↔ topbar + gönderi eviction (#2600)", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
		flags.navIa = false;
	});
	afterEach(() => {
		flags.navIa = false;
		vi.clearAllMocks();
	});

	it("flag off, signed in: the topbar carries + gönderi and there is no Subnav CTA (today's surface)", () => {
		renderApp("/pano");
		act(() => {
			setSession(SIGNED_IN);
		});
		expect(screen.getByRole("button", {name: "+ gönderi"})).toBeTruthy();
		expect(screen.queryByRole("button", {name: "yeni gönderi"})).toBeNull();
	});

	it("flag on, signed in: the topbar + gönderi is evicted and the CTA lives in the pano Subnav zone", () => {
		flags.navIa = true;
		const {container} = renderApp("/pano");
		act(() => {
			setSession(SIGNED_IN);
		});
		// Eviction half: the topbar no longer carries the pano primary action.
		expect(screen.queryByRole("button", {name: "+ gönderi"})).toBeNull();
		// Landing half: the primary action is reachable from the pano product Subnav zone,
		// not the global topbar.
		const cta = screen.getByRole("button", {name: "yeni gönderi"});
		expect(container.querySelector(".kp-subnav")?.contains(cta)).toBe(true);
		expect(container.querySelector(".kp-topbar")?.contains(cta)).toBe(false);
	});

	it("flag on, signed out: the topbar giriş yap is unchanged and no CTA appears (signed-in only)", () => {
		flags.navIa = true;
		const {container} = renderApp("/pano");
		act(() => {
			setSession({data: null, isPending: false});
		});
		expect(screen.getByRole("button", {name: "giriş yap"})).toBeTruthy();
		expect(screen.queryByRole("button", {name: "yeni gönderi"})).toBeNull();
		// The pano product zone still paints its Subnav frame — just with an empty CTA slot.
		expect(container.querySelector(".kp-subnav")).toBeTruthy();
	});
});

// The mecmua nav-IA delta (#2603, epic #2596): the akış sub-destination is pulled OUT of the
// global topbar product-noun row and into the mecmua Subnav zone. Off ⇒ today's surface (akış
// in the topbar, gated on mecmua-feed); on ⇒ akış leaves the topbar and lives in the mecmua
// product zone, still gated on the same mecmua-feed seam (never a dead link).
describe("nav-IA mecmua delta: akış moves from topbar into the mecmua Subnav zone (#2603)", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
		flags.navIa = false;
		flags.mecmuaFeed = false;
	});
	afterEach(() => {
		flags.navIa = false;
		flags.mecmuaFeed = false;
		vi.clearAllMocks();
	});

	it("flag off: akış stays in the topbar (today's surface, gated on mecmua-feed)", () => {
		flags.mecmuaFeed = true;
		const {container} = renderApp("/mecmua");
		act(() => {
			setSession({data: null, isPending: false});
		});
		const akis = screen.getByRole("link", {name: "akış"});
		expect(container.querySelector(".kp-topbar")?.contains(akis)).toBe(true);
	});

	it("flag on: akış is evicted from the topbar and lives in the mecmua Subnav zone", () => {
		flags.navIa = true;
		flags.mecmuaFeed = true;
		const {container} = renderApp("/mecmua");
		act(() => {
			setSession({data: null, isPending: false});
		});
		const akis = screen.getByRole("link", {name: "akış"});
		// Eviction half: the topbar product-noun row no longer carries akış.
		expect(container.querySelector(".kp-topbar")?.contains(akis)).toBe(false);
		// Landing half: akış lives in the mecmua product Subnav zone.
		expect(container.querySelector(".kp-subnav")?.contains(akis)).toBe(true);
	});

	it("flag on, mecmua-feed off: no akış link anywhere (still gated on its own seam)", () => {
		flags.navIa = true;
		renderApp("/mecmua");
		act(() => {
			setSession({data: null, isPending: false});
		});
		expect(screen.queryByRole("link", {name: "akış"})).toBeNull();
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

// The authed-tier feed snapshot wiring (#2321): FateProvider hydrates the identity-keyed
// client at creation on the RESOLVED id (never anon), installs per-identity persistence, and
// tears down the previous identity's snapshot on an identity change / sign-out — all through
// the REAL FateProvider gate the invariant-2 tests pin (#438-safe). The snapshot module is
// spied (snapshotSpies), so these assert the SEAM fires, not the storage effect.
describe("Authed feed snapshot wiring (#2321)", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
		snapshotSpies.hydrateAuthedClient.mockClear();
		snapshotSpies.installAuthedSnapshotPersistence.mockClear();
		snapshotSpies.teardownAuthedSnapshot.mockClear();
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("AC1/AC4: hydrates the authed client ONCE on the resolved identity (never anon) + installs persistence", () => {
		renderApp(FATE_FREE_ROUTE);
		// Pending: the gate is deferred, so no authed client has been created/hydrated yet.
		expect(snapshotSpies.hydrateAuthedClient).not.toHaveBeenCalled();

		act(() => {
			setSession({
				data: {user: {id: "user-42", name: "Elif", email: "elif@kamp.us"}},
				isPending: false,
			});
		});

		// Hydrated exactly once, keyed on the resolved id — never a leading anon hydrate (the
		// #438 re-key would have produced an anon-keyed pass first).
		expect(snapshotSpies.hydrateAuthedClient).toHaveBeenCalledTimes(1);
		expect(snapshotSpies.hydrateAuthedClient).toHaveBeenCalledWith(expect.anything(), "user-42");
		expect(snapshotSpies.installAuthedSnapshotPersistence).toHaveBeenCalledWith(
			expect.anything(),
			"user-42",
		);
	});

	it("AC3: an identity switch A→B tears down the PREVIOUS identity's snapshot", () => {
		renderApp(FATE_FREE_ROUTE);
		act(() => {
			setSession({
				data: {user: {id: "user-A", name: "Ada", email: "ada@kamp.us"}},
				isPending: false,
			});
		});
		expect(snapshotSpies.teardownAuthedSnapshot).not.toHaveBeenCalled(); // first identity, nothing prior

		act(() => {
			setSession({
				data: {user: {id: "user-B", name: "Bora", email: "bora@kamp.us"}},
				isPending: false,
			});
		});
		expect(snapshotSpies.teardownAuthedSnapshot).toHaveBeenCalledWith("user-A");
	});

	it("AC3: sign-out / account deletion (A→signed-out) tears down A's snapshot", () => {
		renderApp(FATE_FREE_ROUTE);
		act(() => {
			setSession({
				data: {user: {id: "user-A", name: "Ada", email: "ada@kamp.us"}},
				isPending: false,
			});
		});
		act(() => {
			setSession({data: null, isPending: false}); // session ends
		});
		expect(snapshotSpies.teardownAuthedSnapshot).toHaveBeenCalledWith("user-A");
	});

	it("identity-scoped: a signed-out settle hydrates NO authed snapshot (anon owns none)", () => {
		renderApp(FATE_FREE_ROUTE);
		act(() => {
			setSession({data: null, isPending: false});
		});
		expect(snapshotSpies.hydrateAuthedClient).not.toHaveBeenCalled();
		expect(snapshotSpies.installAuthedSnapshotPersistence).not.toHaveBeenCalled();
	});
});
