/**
 * The #5175 ruling, enforced against the skills instead of only written down (#5217).
 *
 * The planning and gating lanes are exempt from the `ready-for:agent` audience fence, and the
 * sanctioned route is `--purpose`, never `--override`. Nothing types that: each lane's claim is a
 * shell line inside a markdown skill, so `plan-epic` shipped a bare `fabrika build claim` for a
 * whole release while `audienceAxisBinds` was already exempting `plan` — the CLI was right and the
 * instruction the agent actually executes was wrong. These are data tests over the real skill files,
 * so dropping the flag turns the suite red.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {audienceAxisBinds, type ClaimPurpose} from "./scope-admission.ts";

/** The skill directory of each exempt lane, and the purpose its claim must carry (#5175). */
const EXEMPT_LANES: Readonly<Record<string, ClaimPurpose>> = {
	"plan-epic": "plan",
	"check-epic-plan": "gate",
};

const skillSource = (skill: string): string =>
	readFileSync(
		fileURLToPath(
			new URL(`../../../../claude-plugins/fabrika/skills/${skill}/SKILL.md`, import.meta.url),
		),
		"utf8",
	);

/** Every `fabrika build claim` command line in a skill — the lines an agent actually runs. */
const claimInvocations = (source: string): ReadonlyArray<string> =>
	source.split("\n").filter((line) => line.trimStart().startsWith("fabrika build claim"));

describe("exempt lanes claim with a purpose, never an override (#5175)", () => {
	for (const [skill, purpose] of Object.entries(EXEMPT_LANES)) {
		// A lane whose claim vanished proves nothing, so zero scope is a failure (ADR 0092).
		it(`${skill} invokes build claim at least once`, () => {
			assert.isAtLeast(
				claimInvocations(skillSource(skill)).length,
				1,
				`${skill}/SKILL.md has no 'fabrika build claim' line — this test would pass vacuously`,
			);
		});

		it(`${skill} claims with --purpose ${purpose}`, () => {
			assert.isFalse(
				audienceAxisBinds(purpose),
				`${purpose} is bound by the audience axis, so ${skill} would still be fenced`,
			);
			for (const line of claimInvocations(skillSource(skill))) {
				assert.include(
					line,
					`--purpose ${purpose}`,
					`${skill}/SKILL.md claims without --purpose ${purpose}, so the audience fence binds it (#5175)`,
				);
			}
		});

		it(`${skill} reaches for no --override`, () => {
			for (const line of claimInvocations(skillSource(skill))) {
				assert.notInclude(
					line,
					"--override",
					`${skill}/SKILL.md routes around admission with --override — the purpose is the sanctioned route`,
				);
			}
		});
	}
});
