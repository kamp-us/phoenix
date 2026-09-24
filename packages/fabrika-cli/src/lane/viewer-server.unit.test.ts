/**
 * The vendored lane viewer's own contract: how it reads a lanes root, and what its HTTP surface
 * answers.
 *
 * `@demlik/tea` shipped `lanesFromDisk` and `serveLaneViewer` without a test of either at the
 * commit this copy is taken from (`78bf0966`), so the edges the source's own docblocks promise are
 * pinned here instead: the two-file convention, a directory that is not a lane, a lane emitted and
 * never run, and a root that cannot be listed. The page is served off disk beside the module, which
 * is the one thing a vendoring can silently break.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9771
 */
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {
	type LaneViewerServer,
	lanesFromDisk,
	serveLaneViewer,
	type TransitionRequest,
} from "./viewer-server.ts";

const WORKFLOW = '{"id":"coder"}';
const EVENTS = '{"task":"issue","event":"ISSUE.WIP"}\n';

/** A lanes root holding one run lane, one never-run lane, a scratch dir and a stray file. */
const lanesRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "fabrika-9771-lanes-"));
	mkdirSync(join(root, "42"));
	writeFileSync(join(root, "42", "workflow.json"), WORKFLOW);
	writeFileSync(join(root, "42", "events.jsonl"), EVENTS);
	mkdirSync(join(root, "43"));
	writeFileSync(join(root, "43", "workflow.json"), WORKFLOW);
	mkdirSync(join(root, "scratch"));
	writeFileSync(join(root, "scratch", "notes.md"), "not a lane");
	writeFileSync(join(root, "README"), "a file, not a directory");
	return root;
};

describe("lanesFromDisk — a lane is a directory holding workflow.json", () => {
	it("reads both files verbatim, keyed by the directory name", async () => {
		const lanes = await lanesFromDisk(lanesRoot());
		expect(lanes.find((lane) => lane.id === "42")).toEqual({
			id: "42",
			workflow: WORKFLOW,
			events: EVENTS,
		});
	});

	it("reads a lane emitted and never run as an empty log, not a broken lane", async () => {
		const lanes = await lanesFromDisk(lanesRoot());
		expect(lanes.find((lane) => lane.id === "43")?.events).toBe("");
	});

	it("skips a directory with no workflow.json and a file at the root", async () => {
		const ids = (await lanesFromDisk(lanesRoot())).map((lane) => lane.id).sort();
		expect(ids).toEqual(["42", "43"]);
	});

	it("stamps the origins it was given on every lane", async () => {
		const origins = {from: {UNBLOCKED: {world: "a human"}}};
		const lanes = await lanesFromDisk(lanesRoot(), {origins});
		expect(lanes).toHaveLength(2);
		expect(lanes.every((lane) => lane.origins === origins)).toBe(true);
	});

	it("throws on a root it cannot list, rather than answering a short list", async () => {
		await expect(lanesFromDisk(join(tmpdir(), "fabrika-9771-absent-root"))).rejects.toThrow();
	});
});

describe("serveLaneViewer — the page and the JSON contract it speaks", () => {
	let server: LaneViewerServer | null = null;
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	const serve = async (transition?: (req: TransitionRequest) => {ok: boolean; message: string}) => {
		const root = lanesRoot();
		server = await serveLaneViewer({
			root,
			port: 0,
			...(transition === undefined ? {} : {transition}),
		});
		return {root, url: server.url};
	};

	it("serves the prebuilt page and every asset it links, off the files beside the module", async () => {
		const {url} = await serve();
		const page = await fetch(`${url}/`);
		expect(page.headers.get("content-type")).toContain("text/html");
		const html = await page.text();
		expect(html).toContain("<title>fabrika lanes</title>");

		const linked = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
		expect(linked.length).toBeGreaterThan(0);
		for (const asset of linked) {
			const res = await fetch(`${url}${asset}`);
			expect(res.headers.get("content-type"), asset).not.toContain("text/html");
		}
	});

	it("lists the root's lanes and names the root as the source", async () => {
		const {root, url} = await serve();
		const body = (await (await fetch(`${url}/api/lanes`)).json()) as {
			lanes: {id: string}[];
			source: string;
		};
		expect(body.source).toBe(root);
		expect(body.lanes.map((lane) => lane.id).sort()).toEqual(["42", "43"]);
	});

	it("hands a posted event to the host's transition and relays its answer in both polarities", async () => {
		const asked: TransitionRequest[] = [];
		const {url} = await serve((req) => {
			asked.push(req);
			return req.event === "WIP"
				? {ok: true, message: "appended WIP"}
				: {ok: false, message: "refused: no edge"};
		});
		const post = async (event: string) =>
			(await fetch(`${url}/api/transition`, {
				method: "POST",
				body: JSON.stringify({lane: "42", event, task: "issue"}),
			}).then((res) => res.json())) as {ok: boolean; exit: number; stdout: string; stderr: string};

		expect(await post("WIP")).toEqual({ok: true, exit: 0, stdout: "appended WIP", stderr: ""});
		expect(await post("DONE")).toEqual({
			ok: false,
			exit: 1,
			stdout: "",
			stderr: "refused: no edge",
		});
		expect(asked).toEqual([
			{lane: "42", event: "WIP", task: "issue"},
			{lane: "42", event: "DONE", task: "issue"},
		]);
	});

	it("is read-only when the host gives it no transition", async () => {
		const {url} = await serve();
		const out = await fetch(`${url}/api/transition`, {method: "POST", body: "{}"}).then((res) =>
			res.json(),
		);
		expect(out).toEqual({ok: false, exit: 1, stdout: "", stderr: "this viewer is read-only"});
	});
});
