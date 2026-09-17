import {describe, expect, it} from "vitest";
import {
	classifyEdgeBootAttempt,
	EDGE_BOOT_RETRY_DELAY_MS,
	formatEdgeBootFailure,
} from "./edge-boot-policy.ts";

const bootTag = (boot: Record<string, unknown>): string =>
	`<script>window.__BOOT__=${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>`;

const shell = (head: string): string =>
	`<!doctype html><html><head>${head}</head><body><div id="root"></div></body></html>`;

describe("classifyEdgeBootAttempt — the three unusable modes stay told apart", () => {
	it("resolves the edge's user off the worker's own injection", () => {
		const html = shell(bootTag({"mecmua-feed": true, user: {id: "u_1", username: "nazim"}}));

		expect(classifyEdgeBootAttempt(1, html)).toEqual({
			outcome: "resolved",
			user: {id: "u_1", username: "nazim"},
		});
	});

	it("names a degraded never-hang guard when the document carries no payload at all", () => {
		// ADR 0179 §4's fallback wire shape: the untransformed asset, no boot script.
		const seen = classifyEdgeBootAttempt(2, shell("<title>kamp.us</title>"));

		expect(seen.outcome).toBe("unusable");
		expect(seen.outcome === "unusable" && seen.reason).toContain(
			"the document carried no window.__BOOT__ at all",
		);
	});

	it("names a null user separately, because that is a session failure and not a degrade", () => {
		const seen = classifyEdgeBootAttempt(3, shell(bootTag({"mecmua-feed": true, user: null})));

		expect(seen.outcome).toBe("unusable");
		expect(seen.outcome === "unusable" && seen.reason).toContain("__BOOT__.user as null");
	});

	it("names matcher drift when a payload is present but unreadable", () => {
		// The shape a `bootScriptTag` change would produce: the assignment is there, the
		// `</script>`-terminated object literal the matcher reaches for is not.
		const seen = classifyEdgeBootAttempt(1, shell("<script>window.__BOOT__ = boot()</script>"));

		expect(seen.outcome).toBe("unusable");
		expect(seen.outcome === "unusable" && seen.reason).toContain("drifted from bootScriptTag");
	});

	it("stamps each reason with its own attempt, so no mode can be read off the wrong read", () => {
		const first = classifyEdgeBootAttempt(1, shell(""));
		const third = classifyEdgeBootAttempt(3, shell(""));

		expect(first.outcome === "unusable" && first.reason.startsWith("#1:")).toBe(true);
		expect(third.outcome === "unusable" && third.reason.startsWith("#3:")).toBe(true);
	});
});

describe("formatEdgeBootFailure — every attempt survives into the thrown message", () => {
	it("reports the modes the loop actually hit rather than only the last one", () => {
		const message = formatEdgeBootFailure([
			"#1: the document carried no window.__BOOT__ at all — the never-hang guard degraded",
			"#2: the edge resolved __BOOT__.user as null — the sign-up session did not reach it",
		]);

		expect(message).toContain("2 attempts, none usable");
		expect(message).toContain("no window.__BOOT__ at all");
		expect(message).toContain("__BOOT__.user as null");
	});
});

describe("EDGE_BOOT_RETRY_DELAY_MS — the retry outlives the bound it retries", () => {
	it("exceeds the 1s never-hang read timeout, so a retry is a new sample", () => {
		// `SHELL_BOOT_READ_TIMEOUT` is `Duration.seconds(1)` in
		// `worker/features/flagship/shell-boot-route.ts`. A delay at or under it would leave the
		// retry inside the window that degraded the previous read.
		expect(EDGE_BOOT_RETRY_DELAY_MS).toBeGreaterThan(1_000);
	});
});
