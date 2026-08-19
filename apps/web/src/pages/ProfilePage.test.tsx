/**
 * Precedence pins for `ProfilePage`'s `readUsername` (#2188). `App.test.tsx` mocks both
 * `useMe` and `useProfileStats` inert, so a silent revert to `me?.username` — which
 * reintroduces the serial waterfall — passes every test there but fails here.
 */
import {render, screen} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ProfilePage} from "./ProfilePage";

// `sessionUsername === undefined` models the post-setUsername lag window.
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

const statsCalls: (string | null | undefined)[] = [];
vi.mock("./useProfileStats", () => ({
	useProfileStats: (username: string | null | undefined) => {
		statsCalls.push(username);
		return {status: "idle"};
	},
}));

vi.mock("../components/profile/ProfileContributionSignal", () => ({
	ProfileContributionSignal: ({username}: {username: string}) => (
		<div data-testid="contrib-username">{username}</div>
	),
}));

vi.mock("../components/profile/CaylakStatusBlock", () => ({CaylakStatusBlock: () => null}));
vi.mock("../components/profile/DeleteAccountDialog", () => ({DeleteAccountDialog: () => null}));
vi.mock("../components/profile/ProfileHeader", () => ({ProfileHeader: () => null}));

// Flag ON so the contribution signal renders and its `username` prop is observable.
vi.mock("../flags/useFlag", () => ({useFlag: () => ({value: true, loading: false})}));

vi.mock("../lib/theme", () => ({useTheme: () => ({choice: "auto", setChoice: vi.fn()})}));
vi.mock("../lib/density", () => ({useDensity: () => ({choice: "normal", setChoice: vi.fn()})}));

// Keep react-fate's real `view` — `SetDisplayNameView` calls it at module load — while
// stubbing the client hook so no transport is built.
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
		// The two sources DIVERGE, so the assertion names which one won.
		sessionUsername = "session-uname";
		meUsername = "stale-me-uname";

		renderProfile();

		expect(statsCalls.at(-1)).toBe("session-uname");
		expect(screen.getByTestId("contrib-username").textContent).toBe("session-uname");
	});

	it("falls back to me.username when the session username is absent (the post-setUsername lag window)", () => {
		sessionUsername = undefined;
		meUsername = "canonical-me-uname";

		renderProfile();

		expect(statsCalls.at(-1)).toBe("canonical-me-uname");
		expect(screen.getByTestId("contrib-username").textContent).toBe("canonical-me-uname");
	});
});

describe("ProfilePage appearance controls", () => {
	it("uses the shared Manti outline ToggleGroup without the retired page override", () => {
		sessionUsername = "session-uname";
		meUsername = "session-uname";

		renderProfile();

		const themeGroup = screen
			.getByRole("radio", {name: "koyu"})
			.closest('[data-scope="toggle-group"][data-part="root"]');
		const densityGroup = screen
			.getByRole("radio", {name: "normal"})
			.closest('[data-scope="toggle-group"][data-part="root"]');

		for (const group of [themeGroup, densityGroup]) {
			expect(group?.classList).toContain("kp-toggle-group--outline");
			expect(group?.classList).not.toContain("kp-profile__theme-toggle");
		}
	});

	it("promotes account deletion as the dangerous area's primary action", () => {
		sessionUsername = "session-uname";
		meUsername = "session-uname";

		renderProfile();

		expect(screen.getByTestId("delete-account-btn").getAttribute("data-variant")).toBe("primary");
	});
});
