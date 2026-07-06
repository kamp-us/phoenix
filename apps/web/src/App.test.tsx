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
 */
import {act, render, screen} from "@testing-library/react";
import type {ReactNode} from "react";
import {MemoryRouter} from "react-router";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {App} from "./App";

// The mounts the FateProvider gate commits, in order. Each entry is one `FateClient`
// mount, recording the `key` it committed under. Invariant 2 reads this back: one entry
// keyed on the resolved identity is correct; a second entry (or a leading "anon" entry)
// is the #438 anon→id remount.
type FateMount = {key: string};
const fateMounts: FateMount[] = [];

// Spy `FateClient` in place of react-fate's real one, driving the REAL `FateProvider`
// (its real `if (session.isPending) return null` gate + real `key={userId ?? "anon"}`).
// React consumes `key` itself and never forwards it as a readable prop, so instead of
// reading the key the spy records, ON MOUNT, the session identity live from the same
// source the real FateProvider keys on — the mocked `useSession`. React remounts the spy
// exactly when the committed `key` changes, so one recorded mount == one real key, and a
// second recorded mount is exactly the anon→id remount invariant 2 forbids. Recording on
// MOUNT (an empty-dep effect), not per render, is what makes a remount observable.
vi.mock("react-fate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-fate")>();
	const {useEffect} = await import("react");
	const {useSession} = await import("./auth/client");
	function FateClientSpy({children}: {children: ReactNode}) {
		const session = useSession();
		const key = session.data?.user.id ?? "anon";
		useEffect(() => {
			// Empty deps: fires once per real mount. A re-key (anon→id) tears this instance
			// down and mounts a fresh one, firing this again — the double-mount we're pinning.
			fateMounts.push({key});
		}, []);
		return <>{children}</>;
	}
	return {...actual, FateClient: FateClientSpy};
});

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
vi.mock("./flags/useFlag", () => ({useFlag: () => ({value: false, status: "ok"})}));

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
