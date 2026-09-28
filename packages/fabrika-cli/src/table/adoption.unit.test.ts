/**
 * What a failed table read means: a missing `project` scope passes whether or not the table was
 * adopted, and every other failure is UNKNOWN once it was.
 */
import {describe, expect, it} from "vitest";
import {SHIPPED_TABLE} from "../config/keys/table.ts";
import {PROJECT_SCOPE_FIX} from "../io/projects.ts";
import {failedRead, type Known, type ReadFailure} from "./adoption.ts";

const ADOPTED: Known = {_tag: "Adopted", settings: SHIPPED_TABLE};
const UNADOPTED: Known = {_tag: "Unadopted", settings: SHIPPED_TABLE};
const SCOPE = {
	_tag: "MissingScope",
	reason: `the GitHub token lacks the \`project\` scope — run \`${PROJECT_SCOPE_FIX}\``,
} as const satisfies ReadFailure;
const OUTAGE = {_tag: "Failed", reason: "API rate limit exceeded"} as const satisfies ReadFailure;

describe("failedRead", () => {
	it("goes on unread past a missing scope under an adopted table", () => {
		expect(failedRead(ADOPTED, SCOPE)).toEqual({
			_tag: "Unread",
			reason: SCOPE.reason,
			excuse: "MissingScope",
		});
	});

	it("is UNKNOWN on any other failure under an adopted table", () => {
		expect(failedRead(ADOPTED, OUTAGE)).toEqual({_tag: "Unknown", reason: OUTAGE.reason});
	});

	it("goes on unread past a missing scope under an unadopted table, excused by the adoption", () => {
		expect(failedRead(UNADOPTED, SCOPE)).toEqual({
			_tag: "Unread",
			reason: SCOPE.reason,
			excuse: "Unadopted",
		});
	});

	it("goes on unread past any other failure under an unadopted table", () => {
		expect(failedRead(UNADOPTED, OUTAGE)).toMatchObject({_tag: "Unread", excuse: "Unadopted"});
	});
});
