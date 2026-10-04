/**
 * Read one GitHub Actions repository variable.
 *
 * The value comes back `Redacted` whatever the variable is. A variable is not a secret to GitHub,
 * but the one caller this exists for reads logins out of it, and wrapping at the transport is what
 * keeps the plain value from existing anywhere a log line could reach.
 *
 * `Absent` is the platform's 404: no variable of that name on this repository. A token that may not
 * read variables answers 403, which is `Unknown`, so "nobody set it" and "you may not look" stay
 * two answers.
 */
import {Effect, Redacted} from "effect";
import {authedExistence, existenceOf, restRead} from "./gh-api.ts";
import {fail, ok, type Shell} from "./git.ts";
import type {Existence} from "./issues.ts";
import {isRecord} from "./json.ts";

export const getRepoVariable = (
	repo: string,
	name: string,
): Shell<Existence<Redacted.Redacted<string>>> =>
	authedExistence((token) =>
		Effect.map(
			restRead(token, "GET", `repos/${repo}/actions/variables/${encodeURIComponent(name)}`),
			(outcome) =>
				existenceOf(outcome, (body) =>
					isRecord(body) && typeof body.value === "string"
						? ok(Redacted.make(body.value))
						: fail(`the answer for variable ${name} carries no value`),
				),
		),
	);
