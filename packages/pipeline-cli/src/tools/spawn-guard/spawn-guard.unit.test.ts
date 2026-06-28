import {assert, describe, it} from "@effect/vitest";
import {
	ALLOWLIST,
	DEFAULT_PIN,
	decideSpawn,
	formatSessionCost,
	isOnAllowlist,
} from "./spawn-guard.ts";

describe("isOnAllowlist — only the opus-4.8 family", () => {
	it("accepts the canonical opus-4.8 ids", () => {
		assert.isTrue(isOnAllowlist("claude-opus-4-8"));
		assert.isTrue(isOnAllowlist("claude-opus-4-8[1m]"));
	});

	it("trims surrounding whitespace before matching", () => {
		assert.isTrue(isOnAllowlist("  claude-opus-4-8  "));
	});

	it("rejects fable-5 — the silent 'tokens going brrrr' leak this guard kills", () => {
		assert.isFalse(isOnAllowlist("claude-fable-5"));
		assert.isFalse(isOnAllowlist("claude-mythos-5"));
	});

	it("rejects downgrades and any other model", () => {
		assert.isFalse(isOnAllowlist("claude-sonnet-4-6"));
		assert.isFalse(isOnAllowlist("claude-haiku-4-5"));
		assert.isFalse(isOnAllowlist("claude-opus-4-7"));
	});

	it("rejects an unset / empty model (fail-closed input)", () => {
		assert.isFalse(isOnAllowlist(null));
		assert.isFalse(isOnAllowlist(undefined));
		assert.isFalse(isOnAllowlist(""));
		assert.isFalse(isOnAllowlist("   "));
	});
});

describe("decideSpawn — allowlist guard (allow / allow-inherit / deny)", () => {
	it("ALLOWS an allowlisted requested model (the explicit valid choice stands)", () => {
		const d = decideSpawn("claude-opus-4-8", null);
		assert.strictEqual(d.kind, "allow");
		assert.strictEqual(d.kind === "allow" ? d.model : "", "claude-opus-4-8");
	});

	it("ALLOW-INHERITS an unset request when the pin is on the allowlist (inherit session model, #776)", () => {
		const d = decideSpawn(null, "claude-opus-4-8");
		assert.strictEqual(d.kind, "allow-inherit");
		assert.strictEqual(d.kind === "allow-inherit" ? d.pin : "", "claude-opus-4-8");
		// pin came from the env, not the committed default
		assert.strictEqual(d.kind === "allow-inherit" ? d.defaulted : true, false);
	});

	it("ALLOW-INHERITS an unset request even with the full pin id as the pin (#776 — never rewrite to it)", () => {
		const d = decideSpawn(null, "claude-opus-4-8[1m]");
		assert.strictEqual(d.kind, "allow-inherit");
		assert.strictEqual(d.kind === "allow-inherit" ? d.pin : "", "claude-opus-4-8[1m]");
	});

	it("DENIES an explicit off-allowlist request even when the pin is valid (the pin can't override it, #776)", () => {
		const d = decideSpawn("claude-fable-5", "claude-opus-4-8[1m]");
		assert.strictEqual(d.kind, "deny");
		if (d.kind === "deny") {
			assert.strictEqual(d.requested, "claude-fable-5");
			assert.isTrue(d.explicitOffAllowlist);
		}
	});

	it("ALLOW-INHERITS an unset request with NO env pin via the committed DEFAULT_PIN (#943 durable default, ADR 0116)", () => {
		// A fresh clone / CI / cron with no WORKFLOW_MODEL in-shell no longer re-hits the
		// #776 fail-closed-on-unset symptom — the absent pin falls back to the committed default.
		const d = decideSpawn(null, null);
		assert.strictEqual(d.kind, "allow-inherit");
		if (d.kind === "allow-inherit") {
			assert.strictEqual(d.pin, DEFAULT_PIN);
			assert.isTrue(d.defaulted); // pin came from the committed default, not the env
		}
	});

	it("an empty/whitespace env pin counts as absent and still defaults (not a misconfiguration)", () => {
		for (const blank of ["", "   "]) {
			const d = decideSpawn(null, blank);
			assert.strictEqual(d.kind, "allow-inherit");
			assert.strictEqual(d.kind === "allow-inherit" ? d.defaulted : false, true);
		}
	});

	it("the committed DEFAULT_PIN is itself on the allowlist (else the default would deny)", () => {
		assert.isTrue(isOnAllowlist(DEFAULT_PIN));
	});

	it("DENIES an off-allowlist request with no pin (never a silent allow)", () => {
		const d = decideSpawn("claude-fable-5", null);
		assert.strictEqual(d.kind, "deny");
		// no valid pin ⇒ the fail-closed default reason, not the explicit-off-allowlist one
		assert.strictEqual(d.kind === "deny" ? d.explicitOffAllowlist : true, false);
	});

	it("DENIES when the pin itself is off-allowlist (a misconfigured pin can't smuggle a bad model)", () => {
		const d = decideSpawn(null, "claude-fable-5");
		assert.strictEqual(d.kind, "deny");
		assert.strictEqual(d.kind === "deny" ? d.explicitOffAllowlist : true, false);
	});

	it("a valid request stands even when the pin is garbage", () => {
		const d = decideSpawn("claude-opus-4-8", "claude-fable-5");
		assert.strictEqual(d.kind, "allow");
	});

	it("every decision emits what it checked (ADR 0092 observability)", () => {
		for (const d of [
			decideSpawn("claude-opus-4-8", null),
			decideSpawn(null, "claude-opus-4-8"),
			decideSpawn(null, null),
		]) {
			assert.include(d.checked, "allowlist=[");
			assert.include(d.checked, "requested=");
			assert.include(d.checked, "WORKFLOW_MODEL=");
		}
	});

	it("the allowlist is exactly the opus-4.8 family", () => {
		assert.deepStrictEqual([...ALLOWLIST], ["claude-opus-4-8", "claude-opus-4-8[1m]"]);
	});
});

describe("formatSessionCost — statusline cost/token renderer", () => {
	it("formats dollars and tokens together", () => {
		assert.strictEqual(
			formatSessionCost({totalCostUsd: 1.234, totalTokens: 45_000}),
			"$1.23 · 45.0K tok",
		);
	});

	it("shows sub-cent spend at 4 dp so an early session isn't '$0.00 free'", () => {
		assert.strictEqual(formatSessionCost({totalCostUsd: 0.0042}), "$0.0042");
	});

	it("formats millions of tokens", () => {
		assert.strictEqual(formatSessionCost({totalTokens: 2_500_000}), "2.5M tok");
	});

	it("formats small token counts raw", () => {
		assert.strictEqual(formatSessionCost({totalTokens: 800}), "800 tok");
	});

	it("prefixes the model when present", () => {
		assert.strictEqual(
			formatSessionCost({totalCostUsd: 0.5, totalTokens: 12_000, model: "claude-opus-4-8"}),
			"claude-opus-4-8 · $0.50 · 12.0K tok",
		);
	});

	it("degrades to 'cost n/a' on a payload with no figures (no crash, no blank line)", () => {
		assert.strictEqual(formatSessionCost({}), "cost n/a");
		assert.strictEqual(formatSessionCost({totalCostUsd: null, totalTokens: null}), "cost n/a");
	});

	it("ignores non-finite / negative figures rather than rendering NaN", () => {
		assert.strictEqual(formatSessionCost({totalCostUsd: Number.NaN, totalTokens: -5}), "cost n/a");
	});

	it("shows just the cost when tokens are absent", () => {
		assert.strictEqual(formatSessionCost({totalCostUsd: 3}), "$3.00");
	});
});
