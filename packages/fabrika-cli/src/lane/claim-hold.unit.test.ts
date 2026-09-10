import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {comments, LANE_UUID, served} from "../build/fixtures.test-support.ts";
import {fakeSeams, type HttpReply, okOut, type Scripted} from "../fakes.test-support.ts";
import {claimHoldReader} from "./claim-hold.ts";

const COMMENTS = /^GET .*\/repos\/o\/r\/issues\/5492\/comments\?/;
const PERM = /^GET .*\/repos\/o\/r\/collaborators\/agent\/permission$/;
const REMOTE = /^git remote get-url origin$/;

const WRITE: HttpReply = served({permission: "write"});
const GATEWAY: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};

const LANE_TOKEN = `lane:s-9f2e:${LANE_UUID}`;
const MARKER = `lane-claim: ${LANE_TOKEN} · 2026-08-17T00:00:00Z`;

const read = async (
	lane: string,
	script: ReadonlyArray<Scripted>,
	repo: string | null = "o/r",
	env: Readonly<Record<string, string | undefined>> = {},
) => {
	const seams = fakeSeams(script);
	const hold = await Effect.runPromise(
		Effect.provide(claimHoldReader(repo, env)(lane), seams.layer),
	);
	return {hold, seams};
};

describe("claimHoldReader", () => {
	it("answers Unclaimed for a lane key naming no board number, without reading the board", async () => {
		const {hold, seams} = await read("chore:sweep", []);

		expect(hold).toEqual({_tag: "Unclaimed"});
		expect(seams.requests).toEqual([]);
		expect(seams.calls).toEqual([]);
	});

	it("answers Unknown when no repo resolves — never Unclaimed on an unresolvable target", async () => {
		const {hold, seams} = await read("5492", [], null);

		expect(hold._tag).toBe("Unknown");
		expect(hold._tag === "Unknown" ? hold.reason : "").toContain("no target repo resolves");
		expect(seams.requests).toEqual([]);
	});

	it("relays a readClaimants Unknown rather than reading an unread thread as free", async () => {
		const {hold} = await read("5492", [[COMMENTS, GATEWAY]]);

		expect(hold._tag).toBe("Unknown");
		expect(hold._tag === "Unknown" ? hold.reason : "").toContain("502");
	});

	it("answers Claimed with the holder's token when an authorized marker holds the issue", async () => {
		const {hold} = await read("5492", [
			[COMMENTS, comments({id: 9001, body: MARKER})],
			[PERM, WRITE],
		]);

		expect(hold).toEqual({_tag: "Claimed", token: LANE_TOKEN});
	});

	it("answers Unclaimed when the thread reads and carries no marker", async () => {
		const {hold} = await read("5492", [[COMMENTS, comments()]]);

		expect(hold).toEqual({_tag: "Unclaimed"});
	});

	it("resolves the repo once across lanes rather than per lane", async () => {
		const seams = fakeSeams([
			[REMOTE, okOut("git@github.com:o/r.git\n")],
			[COMMENTS, comments()],
			[/^GET .*\/repos\/o\/r\/issues\/5493\/comments\?/, comments()],
		]);
		const reader = claimHoldReader(null, {});
		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					yield* reader("5492");
					yield* reader("5493");
				}),
				seams.layer,
			),
		);

		expect(seams.calls.filter((line) => line === "git remote get-url origin")).toHaveLength(1);
	});
});
