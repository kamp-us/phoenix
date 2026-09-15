/**
 * The header's three stats states (#9265). The in-flight one is the regression: the read on
 * `/profile` is `network-only`, so the window is a full round-trip on every visit, and the
 * header used to render it as real `0` counts.
 */
import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {LocaleProvider} from "../../i18n";
import {ProfileHeader, type ProfileHeaderStatsState} from "./ProfileHeader";

function mount(stats: ProfileHeaderStatsState) {
	return render(
		<LocaleProvider>
			<ProfileHeader displayName="Elif" handle="elif" stats={stats} showKarma />
		</LocaleProvider>,
	);
}

describe("ProfileHeader stats strip", () => {
	it("renders no counts at all while the read is in flight", () => {
		mount({status: "loading"});

		const strip = screen.getByTestId("stats-loading");
		expect(strip.getAttribute("aria-busy")).toBe("true");
		expect(strip.textContent).not.toContain("0");
		expect(screen.queryByTestId("user-profile-stats")).toBeNull();
		expect(screen.queryByTestId("stat-definitions")).toBeNull();
		expect(screen.queryByTestId("stat-karma")).toBeNull();
		expect(screen.queryByTestId("stats-error")).toBeNull();
	});

	it("renders a genuine zero-activity user as real zeros, not as the placeholder", () => {
		mount({
			status: "ready",
			stats: {definitionCount: 0, postCount: 0, commentCount: 0, totalKarma: 0},
		});

		expect(screen.getByTestId("stat-definitions").textContent).toContain("0");
		expect(screen.getByTestId("stat-posts").textContent).toContain("0");
		expect(screen.getByTestId("stat-comments").textContent).toContain("0");
		expect(screen.queryByTestId("stats-loading")).toBeNull();
	});

	it("renders the counts once they land", () => {
		mount({
			status: "ready",
			stats: {definitionCount: 8, postCount: 2, commentCount: 1, totalKarma: 4},
		});

		expect(screen.getByTestId("stat-definitions").textContent).toContain("8");
		expect(screen.getByTestId("stat-posts").textContent).toContain("2");
		expect(screen.getByTestId("stat-comments").textContent).toContain("1");
		expect(screen.getByTestId("stat-karma").textContent).toContain("4");
	});

	it("renders the error strip, never a count, on a failed read", () => {
		mount({status: "error"});

		expect(screen.getByTestId("stats-error")).toBeTruthy();
		expect(screen.queryByTestId("user-profile-stats")).toBeNull();
		expect(screen.queryByTestId("stats-loading")).toBeNull();
	});
});
