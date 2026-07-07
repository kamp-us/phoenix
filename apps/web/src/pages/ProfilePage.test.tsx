/**
 * Precedence pins for `ProfilePage`'s `readUsername` — the load-bearing me-hop removal
 * of #2188 (ADR 0167's two-tier decoupling extended to `/profile`). The counts + Katkıların
 * reads key on the SESSION username the instant `FateProvider` commits, dropping the third
 * serial `me?.username` round-trip that made the reads land ~822ms late.
 *
 * `App.test.tsx` mocks both `useMe` and `useProfileStats` inert, so it never exercises
 * `readUsername`'s precedence — a silent revert to `me?.username` (reintroducing the serial
 * waterfall) would pass every test there. These render the REAL `ProfilePage` and read back
 * which username the two identity-scoped reads actually receive: the counts read via the
 * `useProfileStats` argument, and the contributions read via the `ProfileContributionSignal`
 * `username` prop. The precedence test fails on that revert; the fallback test guards the
 * `me` fallback for the brief post-`setUsername` window the session row lags.
 */
import {render, screen} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ProfilePage} from "./ProfilePage";

// Controllable session + `me` — the two identity sources `readUsername` chooses between.
// `sessionUsername === undefined` models the absent session `username` (the post-setUsername
// lag window); a string models the settled, present-and-correct value.
let sessionUsername: string | null | undefined;
let meUsername: string | null;

vi.mock("../auth/client", () => ({
	useSession: () => ({
		data: {user: {id: "u-1", email: "owner@kamp.us", name: "Owner", username: sessionUsername}},
		isPending: false,
		refetch: vi.fn(async () => undefined),
	}),
	authClient: {signOut: vi.fn(), revokeSessions: vi.fn()},
	clearBearerToken: vi.fn(),
}));

vi.mock("../auth/useMe", () => ({
	useMe: () => ({
		me: {
			id: "me-1",
			email: "owner@kamp.us",
			name: "Owner",
			image: null,
			username: meUsername,
			tier: null,
			isModerator: false,
		},
		status: "ok",
		loading: false,
		refetch: vi.fn(async () => undefined),
	}),
}));

// Capture the username the COUNTS read (`useProfileStats`) receives — the arg IS the
// assertion. Stays `idle` so it touches no wire.
const statsCalls: (string | null | undefined)[] = [];
vi.mock("./useProfileStats", () => ({
	useProfileStats: (username: string | null | undefined) => {
		statsCalls.push(username);
		return {status: "idle"};
	},
}));

// Capture the username the CONTRIBUTIONS read receives via the real prop `ProfilePage`
// passes; rendered inert (its own fate reads are pinned by ProfileContributionSignal's tests).
vi.mock("../components/profile/ProfileContributionSignal", () => ({
	ProfileContributionSignal: ({username}: {username: string}) => (
		<div data-testid="contrib-username">{username}</div>
	),
}));

// Inert stubs for the fate-touching / dialog children — not under test here.
vi.mock("../components/profile/CaylakStatusBlock", () => ({CaylakStatusBlock: () => null}));
vi.mock("../components/profile/DeleteAccountDialog", () => ({DeleteAccountDialog: () => null}));
vi.mock("../components/profile/ProfileHeader", () => ({ProfileHeader: () => null}));

// Flag ON so the Katkıların contribution signal renders and its `username` prop is observable;
// the counts read fires regardless of the flag.
vi.mock("../flags/useFlag", () => ({useFlag: () => ({value: true, loading: false})}));

// Appearance controls need their providers; stub the hooks inert — irrelevant to `readUsername`.
vi.mock("../lib/theme", () => ({useTheme: () => ({choice: "auto", setChoice: vi.fn()})}));
vi.mock("../lib/density", () => ({useDensity: () => ({choice: "normal", setChoice: vi.fn()})}));

// Keep react-fate's real `view` (used at module load for `SetDisplayNameView`); stub the
// client hook so no transport is built. `fate.mutations` is only touched by onSaveName, never render.
vi.mock("react-fate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-fate")>();
	return {...actual, useFateClient: () => ({mutations: {}}) as never};
});

function renderProfile() {
	return render(
		<MemoryRouter initialEntries={["/profile"]}>
			<ProfilePage />
		</MemoryRouter>,
	);
}

describe("ProfilePage readUsername precedence (#2188 — the me-hop removal)", () => {
	beforeEach(() => {
		statsCalls.length = 0;
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("keys the counts + contributions reads on the SESSION username, not the round-tripped me row", () => {
		// The session username and the canonical `me` row DIVERGE. The win is reading off the
		// session value (available the instant FateProvider commits), never the later `me` hop.
		sessionUsername = "session-uname";
		meUsername = "stale-me-uname";

		renderProfile();

		// REGRESSION: a silent revert of `readUsername` to `me?.username` reintroduces the serial
		// waterfall — the counts read would receive "stale-me-uname" and this fails.
		expect(statsCalls.at(-1)).toBe("session-uname");
		expect(screen.getByTestId("contrib-username").textContent).toBe("session-uname");
	});

	it("falls back to me.username when the session username is absent (the post-setUsername lag window)", () => {
		// Right after a setUsername write the session row still lags the just-written username, so
		// `session.data.user.username` is absent; the read falls back to the canonical `me` row.
		sessionUsername = undefined;
		meUsername = "canonical-me-uname";

		renderProfile();

		expect(statsCalls.at(-1)).toBe("canonical-me-uname");
		expect(screen.getByTestId("contrib-username").textContent).toBe("canonical-me-uname");
	});
});
