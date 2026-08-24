/**
 * Regression pins for two first-paint invariants (#2177), both guarding previously-real bugs:
 * (1) the `Layout` shell paints FATE-FREE above the session gate, so there is no blank first
 * paint (#2160), and (2) `FateClient` mounts ONCE on the resolved identity — an anon→id remount
 * wipes controlled-form state (#438). Both are pinned by rendering the REAL `App` and observing
 * the REAL `FateProvider` gate through a mount-recording `FateClient` spy; see the two
 * `// REGRESSION:` notes on the assertions.
 */
import {act, render, screen, within} from "@testing-library/react";
import type {ReactNode} from "react";
import {MemoryRouter} from "react-router";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {App} from "./App";
import {WELCOME_SEEN_SCHEMA, welcomeSeenKey} from "./components/onboarding/welcomeSeen";
import {WELCOME_PATH} from "./pages/welcomeGating";

const {PUBLIC_CLIENT} = vi.hoisted(() => ({PUBLIC_CLIENT: {__tier: "public"} as never}));

type FateMount = {key: string; tier: "public" | "authed"};
const fateMounts: FateMount[] = [];

// Spy `FateClient`, driving the REAL `FateProvider`. React consumes `key` itself and never
// forwards it as a readable prop, so the spy instead records the live session identity ON MOUNT
// — one recorded mount == one committed key, which is what makes a remount observable.
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

// Stubbed inert so the tree renders offline: the two-tier tests assert the feed's PRESENCE above
// the gate, not its fate reads.
vi.mock("./pages/PanoFeed", () => ({
	PanoFeed: ({host}: {host?: string}) => <div data-testid="eager-pano-feed">{host ?? "all"}</div>,
}));

// Stubbed inert for the same reason as PanoFeed: the intercept tests assert WHERE the post-auth
// redirect landed, and the surface's own contract is proven in `WelcomePage.test.tsx`. The stub
// echoes the live location, which is what carries the original `returnTo` through the detour.
vi.mock("./pages/WelcomePage", async () => {
	const {useLocation} = await import("react-router");
	return {
		WelcomePage: () => {
			const location = useLocation();
			return <div data-testid="welcome-stub">{`${location.pathname}${location.search}`}</div>;
		},
	};
});

// `AuthPage` calls `useFateClient()` at render, and the spied `FateClient` above provides no real
// context — so the one route the intercept starts from needs an inert stand-in to be reachable
// here at all. Its own behaviour is not under test in this file.
vi.mock("./pages/AuthPage", () => ({AuthPage: () => <div data-testid="auth-stub" />}));

vi.mock("./fate/publicClient", () => ({getPublicFateClient: () => PUBLIC_CLIENT}));

// The session mock must be REACTIVE: a plain mutated variable would never re-render, so
// FateProvider would never re-run its gate and the pending→resolved transition under test
// wouldn't happen. `useSyncExternalStore` gives each consumer a real subscription.
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

// Keep the REAL FateProvider under test, but stub its two network-touching collaborators so it
// runs offline.
vi.mock("./fate/client", () => ({createClient: () => ({}) as never}));
vi.mock("./fate/useGlobalLivePin", () => ({useGlobalLivePin: () => undefined}));

// Spied so the seam is observable independent of the default-off, `window`-bound flag; the pure
// storage contract is proven in `snapshot.test.ts`.
const snapshotSpies = vi.hoisted(() => ({
	hydrateAuthedClient: vi.fn(),
	installAuthedSnapshotPersistence: vi.fn(() => () => {}),
	teardownAuthedSnapshot: vi.fn(),
}));
vi.mock("./fate/snapshot", () => snapshotSpies);

// The fate-consuming hooks below the gate, stubbed inert so `LayoutContent` renders offline.
vi.mock("./auth/useMe", () => ({
	useMe: () => ({me: null, status: "idle", loading: false, refetch: vi.fn()}),
}));
vi.mock("./pages/useProfileStats", () => ({useProfileStats: () => ({status: "idle"})}));
vi.mock("./components/divan/useDivanAccess", () => ({useDivanAccess: () => false}));
vi.mock("./components/bildirim/useBildirimUnread", () => ({useBildirimUnread: () => 0}));

// `loading: false` on every read models the shell-key members' synchronous `__BOOT__` resolution
// (ADR 0179): a member carries its final value on the first render, with no post-boot flip.
// `signedIn` drives the mocked `readBootUser` below; default false = `__BOOT__` absent.
const flags = vi.hoisted(() => ({
	mecmua: false,
	mecmuaFeed: false,
	welcome: false,
	signedIn: false,
}));
vi.mock("./flags/useFlag", async () => {
	const {MECMUA_PUBLIC_READ, MECMUA_FEED, PHOENIX_WELCOME} = await import("./flags/keys");
	return {
		useFlag: (key: string) => ({
			value:
				key === MECMUA_PUBLIC_READ
					? flags.mecmua
					: key === MECMUA_FEED
						? flags.mecmuaFeed
						: key === PHOENIX_WELCOME
							? flags.welcome
							: false,
			loading: false,
		}),
	};
});
// The edge-resolved `__BOOT__.user` (ADR 0185). `importActual` keeps the real
// `readBoot`/`readBootMember`; only the user read is faked.
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

// A test that settles the session commits FateProvider and mounts the routed page below it, so it
// must route somewhere fate-free — the spied FateClient provides no real context.
function renderApp(route = "/") {
	return render(
		<MemoryRouter initialEntries={[route]}>
			<App />
		</MemoryRouter>,
	);
}
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
		renderApp();

		expect(screen.getByRole("link", {name: /kamp/i})).toBeTruthy();
		expect(screen.getByRole("link", {name: "sözlük"})).toBeTruthy();
		expect(screen.getByRole("link", {name: "pano"})).toBeTruthy();
		expect(screen.getByLabelText("Ara")).toBeTruthy();
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
		expect(screen.getByRole("button", {name: "giriş yap"})).toBeTruthy();
		expect(screen.getByRole("link", {name: /kamp/i})).toBeTruthy();
		expect(fateMounts).toHaveLength(0);
	});

	it("invariant 2: FateClient mounts ONCE on the resolved identity — no anon→id remount (#438)", () => {
		renderApp(FATE_FREE_ROUTE);
		expect(fateMounts).toHaveLength(0);

		act(() => {
			setSession({
				data: {user: {id: "user-42", name: "Elif", email: "elif@kamp.us"}},
				isPending: false,
			});
		});

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

		act(() => {
			setSession({data: null, isPending: false});
		});

		expect(fateMounts).toHaveLength(1);
		expect(fateMounts[0]?.key).toBe("anon");
	});
});

// The shell reads the edge identity at first paint (ADR 0185), so the giriş-yap↔user-cluster swap
// and the name pop-in never happen; absent `__BOOT__` ⇒ today's session-gated render.
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
		expect(screen.queryByRole("button", {name: "giriş yap"})).toBeNull();
		expect(screen.getByText("Elif")).toBeTruthy();
		expect(fateMounts).toHaveLength(0);
	});

	it("__BOOT__ present + user: no content swap when the session settles signed-in", () => {
		flags.signedIn = true;
		renderApp(FATE_FREE_ROUTE);
		expect(screen.queryByRole("button", {name: "giriş yap"})).toBeNull();
		expect(screen.getByText("Elif")).toBeTruthy();
		act(() => {
			setSession({
				data: {user: {id: "user-42", name: "Elif", email: "elif@kamp.us"}},
				isPending: false,
			});
		});
		expect(screen.queryByRole("button", {name: "giriş yap"})).toBeNull();
		expect(screen.getByText("Elif")).toBeTruthy();
	});

	// #6577: the edge resolved a user the settled session denies. The account slot collapses (no
	// pill, no placeholder), so the CTA must come back — otherwise the shell offers no sign-in
	// path at all and the viewer reads it as broken rather than signed out.
	it("__BOOT__ present but the session settles signed-out: giriş-yap returns and the account slot is empty", () => {
		flags.signedIn = true;
		renderApp(FATE_FREE_ROUTE);
		expect(screen.queryByRole("button", {name: "giriş yap"})).toBeNull();

		act(() => {
			setSession({data: null, isPending: false});
		});

		expect(screen.getByRole("button", {name: "giriş yap"})).toBeTruthy();
		expect(screen.queryByText("Elif")).toBeNull();
		expect(screen.queryByTestId("topbar-user-placeholder")).toBeNull();
	});

	// #6660: the same divergence, read as the coupling itself. `LayoutContent` publishes no
	// `userProps` for a signed-out session, so the spread falls through to the boot props and the
	// topbar is handed a `user` — the account side stays empty only because the CTA's own
	// condition gates it. Drop that gate and this render carries a phantom pill beside `giriş yap`.
	it("__BOOT__ present, settled signed-out, no userProps published: the CTA and the account side never share a render", () => {
		flags.signedIn = true;
		const {container} = renderApp(FATE_FREE_ROUTE);

		act(() => {
			setSession({data: null, isPending: false});
		});

		expect(screen.getByRole("button", {name: "giriş yap"})).toBeTruthy();
		expect(container.querySelector(".kp-topbar__user")).toBeNull();
		// The gate that empties the account side also decides where the theme control lives: with
		// no user menu to carry it, the utility-zone picker must render (#2612).
		expect(
			within(screen.getByTestId("topbar-zone-utility")).getByTestId("topbar-theme-picker"),
		).toBeTruthy();
	});

	// The other direction of the same gate: with no `__BOOT__` the claim comes from the settled
	// session alone, so widening it to cover the pill must not cost a signed-in visitor their menu.
	it("__BOOT__ absent but the session settles signed-in: the account pill renders and no CTA does", () => {
		const {container} = renderApp(FATE_FREE_ROUTE);
		expect(screen.getByRole("button", {name: "giriş yap"})).toBeTruthy();

		act(() => {
			setSession({
				data: {user: {id: "user-42", name: "Elif", email: "elif@kamp.us"}},
				isPending: false,
			});
		});

		expect(screen.queryByRole("button", {name: "giriş yap"})).toBeNull();
		expect(container.querySelector(".kp-topbar__user")).not.toBeNull();
		expect(screen.getByText("Elif")).toBeTruthy();
	});

	it("__BOOT__ absent (readBootUser null): the shell is exactly as today — giriş-yap, no account cluster (AC-3)", () => {
		renderApp();
		expect(screen.getByRole("button", {name: "giriş yap"})).toBeTruthy();
		expect(screen.queryByText("Elif")).toBeNull();
		expect(screen.queryByTestId("topbar-user-placeholder")).toBeNull();
	});
});

// The mecmua nav entry is a shell-key member, so it resolves synchronously and lands in its final
// nav position on the FIRST paint — no false→true pop-in (#2828, ADR 0179).
describe("mecmua nav entry (#2828) — resolves at first paint from __BOOT__, no pop-in", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
		flags.mecmua = false;
	});
	afterEach(() => {
		flags.mecmua = false;
		vi.clearAllMocks();
	});

	it("off: the kill-switch dark ⇒ no mecmua nav link (the route's dark-ship posture is preserved)", () => {
		renderApp();
		expect(screen.queryByRole("link", {name: "mecmua"})).toBeNull();
		expect(screen.getByRole("link", {name: "sözlük"})).toBeTruthy();
		expect(screen.getByRole("link", {name: "pano"})).toBeTruthy();
	});

	it("on: mecmua paints on the FIRST render (session still pending), in final position after pano", () => {
		flags.mecmua = true;
		renderApp();
		const mecmua = screen.getByRole("link", {name: "mecmua"});
		expect(mecmua.getAttribute("href")).toBe("/mecmua");
		const navLinks = ["sözlük", "pano", "mecmua"].map((label) =>
			screen.getByRole("link", {name: label}),
		);
		const order = navLinks.map((el) =>
			Array.prototype.indexOf.call(document.querySelectorAll("a"), el),
		);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(fateMounts).toHaveLength(0);
	});
});

// The akış entry gates on the SAME `mecmua-feed` seam its route self-gates on, so the link can
// never point at a dark 404 (#2547).
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
		renderApp("/mecmua");
		act(() => {
			setSession({data: null, isPending: false});
		});
		expect(screen.queryByRole("link", {name: "akış"})).toBeNull();
	});

	it("on: the flag flipped ⇒ the akış nav link paints and points at /mecmua/akis", () => {
		flags.mecmuaFeed = true;
		renderApp("/mecmua");
		act(() => {
			setSession({data: null, isPending: false});
		});
		const link = screen.getByRole("link", {name: "akış"});
		expect(link.getAttribute("href")).toBe("/mecmua/akis");
	});
});

// The routed page mounts below the session gate, so these settle the session to commit the
// Outlet (#2598).
describe("nav-IA per-product Subnav zone substrate (#2598)", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("the /pano route mounts under the product layout — a persistent Subnav zone paints above the page", () => {
		const {container} = renderApp("/pano");
		act(() => {
			setSession({data: null, isPending: false});
		});
		expect(container.querySelector(".kp-subnav")).toBeTruthy();
	});

	it("a non-product route (/search) mounts NO product Subnav zone", () => {
		const {container} = renderApp("/search");
		act(() => {
			setSession({data: null, isPending: false});
		});
		expect(container.querySelector(".kp-subnav")).toBeNull();
	});
});

// The atomic coupling (#2600): the pano primary action sits in pano's Subnav CTA slot, never the
// global topbar.
const SIGNED_IN = {data: {user: {id: "u1", name: "Elif", email: "elif@kamp.us"}}, isPending: false};
describe("nav-IA coupling: pano/yeni Subnav CTA ↔ topbar + gönderi eviction (#2600)", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("signed in: the topbar + gönderi is evicted and the CTA lives in the pano Subnav zone", () => {
		const {container} = renderApp("/pano");
		act(() => {
			setSession(SIGNED_IN);
		});
		expect(screen.queryByRole("button", {name: "+ gönderi"})).toBeNull();
		const cta = screen.getByRole("button", {name: "yeni gönderi"});
		expect(container.querySelector(".kp-subnav")?.contains(cta)).toBe(true);
		expect(container.querySelector(".kp-topbar")?.contains(cta)).toBe(false);
	});

	it("signed out: the topbar giriş yap is unchanged and no CTA appears (signed-in only)", () => {
		const {container} = renderApp("/pano");
		act(() => {
			setSession({data: null, isPending: false});
		});
		expect(screen.getByRole("button", {name: "giriş yap"})).toBeTruthy();
		expect(screen.queryByRole("button", {name: "yeni gönderi"})).toBeNull();
		expect(container.querySelector(".kp-subnav")).toBeTruthy();
	});
});

// akış lives in the mecmua Subnav zone, not the topbar product-noun row — still gated on its own
// seam (#2603).
describe("nav-IA mecmua delta: akış moves from topbar into the mecmua Subnav zone (#2603)", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
		flags.mecmuaFeed = false;
	});
	afterEach(() => {
		flags.mecmuaFeed = false;
		vi.clearAllMocks();
	});

	it("akış is evicted from the topbar and lives in the mecmua Subnav zone", () => {
		flags.mecmuaFeed = true;
		const {container} = renderApp("/mecmua");
		act(() => {
			setSession({data: null, isPending: false});
		});
		const akis = screen.getByRole("link", {name: "akış"});
		expect(container.querySelector(".kp-topbar")?.contains(akis)).toBe(false);
		expect(container.querySelector(".kp-subnav")?.contains(akis)).toBe(true);
	});

	it("mecmua-feed off: no akış link anywhere (still gated on its own seam)", () => {
		renderApp("/mecmua");
		act(() => {
			setSession({data: null, isPending: false});
		});
		expect(screen.queryByRole("link", {name: "akış"})).toBeNull();
	});
});

// The two-tier public first paint (ADR 0167) — and the hand-off must not drag the authed subtree
// through an anon→id re-key (#438).
describe("Two-tier fate provider — /pano public first paint (#2285)", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("AC2/AC5: the /pano feed paints over the public client while the session is isPending — before the authed gate commits", () => {
		renderApp("/pano");

		expect(screen.getByTestId("eager-pano-feed")).toBeTruthy();
		expect(fateMounts.some((m) => m.tier === "public")).toBe(true);
		expect(fateMounts.some((m) => m.tier === "authed")).toBe(false);
	});

	it("scoped: a non-pano route paints NO public feed (the eager tier is /pano-only)", () => {
		renderApp("/sozluk");
		expect(screen.queryByTestId("eager-pano-feed")).toBeNull();
		expect(fateMounts).toHaveLength(0);
	});

	it("AC4 (#438): after the public first paint, the authed subtree mounts ONCE on the resolved id — no anon→id remount", () => {
		renderApp("/pano");
		expect(fateMounts.filter((m) => m.tier === "authed")).toHaveLength(0);

		act(() => {
			setSession({
				data: {user: {id: "user-7", name: "Deniz", email: "deniz@kamp.us"}},
				isPending: false,
			});
		});

		const authed = fateMounts.filter((m) => m.tier === "authed");
		expect(authed).toHaveLength(1);
		expect(authed[0]?.key).toBe("user-7");
		expect(authed.map((m) => m.key)).not.toContain("anon");
	});
});

// /profile's eager tier paints a SKELETON (the identity-scoped read can't show anon data) and,
// unlike /pano's, mounts NO FateClient — so there is nothing above the gate to re-key (#2188).
describe("Two-tier fate provider — /profile eager Katkıların skeleton (#2188)", () => {
	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("paints the Katkıların skeleton on /profile while the session isPending — before the authed gate commits", () => {
		renderApp("/profile");

		expect(screen.getByTestId("signal-loading")).toBeTruthy();
		expect(fateMounts).toHaveLength(0);
	});

	it("#438: the eager /profile skeleton mounts NO FateClient — nothing to re-key anon→id", () => {
		renderApp("/profile");
		expect(fateMounts).toHaveLength(0);
		expect(screen.getByTestId("signal-loading")).toBeTruthy();
	});

	it("scoped: a non-profile route paints NO eager Katkıların skeleton", () => {
		renderApp("/sozluk");
		expect(screen.queryByTestId("signal-loading")).toBeNull();
		expect(fateMounts).toHaveLength(0);
	});
});

// The search box lives in the fate-free shell, so these render without settling the session (#2199).
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

// The authed-tier snapshot wiring (#2321). The snapshot module is spied, so these assert the SEAM
// fires, not the storage effect.
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
		expect(snapshotSpies.hydrateAuthedClient).not.toHaveBeenCalled();

		act(() => {
			setSession({
				data: {user: {id: "user-42", name: "Elif", email: "elif@kamp.us"}},
				isPending: false,
			});
		});

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
		expect(snapshotSpies.teardownAuthedSnapshot).not.toHaveBeenCalled();

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
			setSession({data: null, isPending: false});
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

// The post-auth welcome intercept (#7043, epic #4304). These pin the WIRING at the redirect
// itself — the pure decision is `postAuthDestination` (`welcomeGating.unit.test.ts`) and the
// surface is `WelcomePage.test.tsx`; what only shows up here is whether the effect consults the
// marker and carries the original `returnTo` through the detour.
describe("post-auth welcome intercept (#7043)", () => {
	const AUTH_ROUTE = `/auth?returnTo=${encodeURIComponent("/pano")}`;

	beforeEach(() => {
		fateMounts.length = 0;
		sessionState = {data: null, isPending: true};
		flags.welcome = false;
		localStorage.clear();
	});
	afterEach(() => {
		flags.welcome = false;
		localStorage.clear();
		vi.clearAllMocks();
	});

	// REGRESSION (criterion 1): with the flag at its default the redirect is exactly today's —
	// the marker is never even read, so a stale marker cannot change where a signup lands.
	it("flag off: the post-auth redirect lands on the returnTo, never the welcome surface", () => {
		renderApp(AUTH_ROUTE);
		act(() => {
			setSession(SIGNED_IN);
		});
		expect(screen.queryByTestId("welcome-stub")).toBeNull();
		expect(screen.getByTestId("eager-pano-feed")).toBeTruthy();
	});

	it("flag off with a marker already set: still today's redirect", () => {
		localStorage.setItem(welcomeSeenKey(WELCOME_SEEN_SCHEMA, "u1"), "1");
		renderApp(AUTH_ROUTE);
		act(() => {
			setSession(SIGNED_IN);
		});
		expect(screen.queryByTestId("welcome-stub")).toBeNull();
		expect(screen.getByTestId("eager-pano-feed")).toBeTruthy();
	});

	// Criterion 2: the brand-new account's first post-signup navigation detours, and the target it
	// was headed for rides along so "devam et" can hand it back.
	it("flag on, never welcomed: the first post-auth navigation lands on the welcome surface", () => {
		flags.welcome = true;
		renderApp(AUTH_ROUTE);
		act(() => {
			setSession(SIGNED_IN);
		});
		expect(screen.getByTestId("welcome-stub").textContent).toBe(
			`${WELCOME_PATH}?returnTo=${encodeURIComponent("/pano")}`,
		);
	});

	it("flag on, no returnTo: the detour carries the cold fallback /", () => {
		flags.welcome = true;
		renderApp("/auth");
		act(() => {
			setSession(SIGNED_IN);
		});
		expect(screen.getByTestId("welcome-stub").textContent).toBe(
			`${WELCOME_PATH}?returnTo=${encodeURIComponent("/")}`,
		);
	});

	// Criterion 4, at the intercept: the marker suppresses the detour on every later arrival.
	it("flag on, already welcomed: the intercept is suppressed and the redirect is today's", () => {
		flags.welcome = true;
		localStorage.setItem(welcomeSeenKey(WELCOME_SEEN_SCHEMA, "u1"), "1");
		renderApp(AUTH_ROUTE);
		act(() => {
			setSession(SIGNED_IN);
		});
		expect(screen.queryByTestId("welcome-stub")).toBeNull();
		expect(screen.getByTestId("eager-pano-feed")).toBeTruthy();
	});

	// The marker is per account, so one welcomed account on a shared browser never silently
	// swallows another's welcome.
	it("flag on, a DIFFERENT account's marker set: this account is still welcomed", () => {
		flags.welcome = true;
		localStorage.setItem(welcomeSeenKey(WELCOME_SEEN_SCHEMA, "someone-else"), "1");
		renderApp(AUTH_ROUTE);
		act(() => {
			setSession(SIGNED_IN);
		});
		expect(screen.getByTestId("welcome-stub")).toBeTruthy();
	});
});
