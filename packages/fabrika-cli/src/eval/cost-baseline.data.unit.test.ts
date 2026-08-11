import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import {decodeCostBaseline, PHASE_2_DEFERRAL} from "./cost-baseline.ts";

// The committed baseline series lives with the fabrika plugin, ruled on #4765 (2026-08-02).
const SERIES_DIR = fileURLToPath(
	new URL("../../../../claude-plugins/fabrika/reports/eval", import.meta.url),
);

const baselineFiles = readdirSync(SERIES_DIR)
	.filter((name) => name.startsWith("baseline-") && name.endsWith(".json"))
	.sort();

describe("the committed cost-baseline series", () => {
	/**
	 * Zero files would let every assertion below pass over nothing — the vacuous green ADR 0092
	 * forbids, and the first shape a mistyped series path would produce.
	 */
	it("finds at least one committed baseline", () => {
		assert.isAtLeast(baselineFiles.length, 1);
	});

	for (const name of baselineFiles) {
		const decoded = decodeCostBaseline(readFileSync(`${SERIES_DIR}/${name}`, "utf8"));

		it(`${name} decodes — a malformed baseline cannot land`, () => {
			assert.isTrue(Result.isSuccess(decoded), `${name} must decode to Ok`);
		});

		it(`${name} carries every pin a later comparison is made against`, () => {
			assert.isTrue(Result.isSuccess(decoded));
			if (!Result.isSuccess(decoded)) return;
			const b = decoded.success;
			for (const pin of [
				b.recordedAt,
				b.corpus.revision,
				b.harness.model,
				b.harness.revision,
				b.harness.pluginDir,
			]) {
				assert.isNotEmpty(pin);
			}
			assert.isNotNull(b.harness.cliVersion);
			// A baseline over unmeasured runs is the fabricated zero the fold refuses; assert the
			// committed file is on the measured side of that refusal rather than trusting the writer.
			assert.isAbove(b.runs.measured, 0);
			assert.isAbove(b.spend.billed, 0);
			assert.strictEqual(b.phase2, PHASE_2_DEFERRAL);
		});
	}
});
