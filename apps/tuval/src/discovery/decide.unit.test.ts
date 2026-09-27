import {assert, describe, it} from "@effect/vitest";
import {Option} from "effect";
import {type DeskRequest, decide} from "./decide.ts";
import type {DeskRecord, DeskRecordRead} from "./record.ts";
import {classify} from "./sighting.ts";

const record: DeskRecord = {version: 1, pid: 4242, page: "http://localhost:5173/"};
const launchUrl = "ws://127.0.0.1:61234/?token=abc";

const found: DeskRecordRead = {_tag: "Found", record};
const absent: DeskRecordRead = {_tag: "Absent"};
const unreadable: DeskRecordRead = {_tag: "Unreadable", reason: "it is not a desk record"};

const live = classify(found, Option.some(launchUrl));
const crashed = classify(found, Option.none());
const none = classify(absent, Option.none());
const garbled = classify(unreadable, Option.none());

const show: DeskRequest = {_tag: "Show", project: "/work/phoenix", startFlags: false};
const open: DeskRequest = {_tag: "Open", folder: "/work/demlik"};

describe("classify", () => {
	it("calls a record live only once its desk answered", () => {
		assert.deepStrictEqual(live, {_tag: "Live", record, launchUrl});
	});

	it("calls a record whose desk does not answer stale, naming its pid", () => {
		assert.deepStrictEqual(crashed, {
			_tag: "Stale",
			reason: "the desk it names (pid 4242) does not answer",
			pid: 4242,
		});
	});

	it("reads no record as no desk", () => {
		assert.deepStrictEqual(none, {_tag: "NoDesk"});
	});

	it("calls an unreadable record stale, and never trusts the answer beside it", () => {
		assert.deepStrictEqual(classify(unreadable, Option.some(launchUrl)), garbled);
		assert.strictEqual(garbled._tag, "Stale");
	});
});

describe("decide: tuval", () => {
	it("starts a desk on its project when none runs", () => {
		assert.deepStrictEqual(decide(show, none), {
			_tag: "Start",
			project: "/work/phoenix",
			stale: null,
		});
	});

	it("brings a running desk forward and starts no second one", () => {
		assert.deepStrictEqual(decide(show, live), {
			_tag: "Forward",
			desk: record,
			startFlagsIgnored: false,
		});
	});

	it("says the start flags go unused when it brings a running desk forward", () => {
		const action = decide({...show, startFlags: true}, live);
		assert.isTrue(action._tag === "Forward" && action.startFlagsIgnored);
	});

	it("replaces a crashed desk's record with a new desk rather than trusting it", () => {
		assert.deepStrictEqual(decide(show, crashed), {
			_tag: "Start",
			project: "/work/phoenix",
			stale: {reason: "the desk it names (pid 4242) does not answer", pid: 4242},
		});
	});

	it("replaces an unreadable record the same way", () => {
		const action = decide(show, garbled);
		assert.isTrue(action._tag === "Start" && action.stale?.pid === null);
	});
});

describe("decide: tuval open", () => {
	it("asks the running desk to open the folder, through the address its page answered with", () => {
		assert.deepStrictEqual(decide(open, live), {
			_tag: "OpenIn",
			desk: record,
			launchUrl,
			folder: "/work/demlik",
		});
	});

	it("starts a desk with the folder as its project when none runs", () => {
		assert.deepStrictEqual(decide(open, none), {
			_tag: "Start",
			project: "/work/demlik",
			stale: null,
		});
	});

	it("starts a desk with the folder over a crashed desk's record", () => {
		const action = decide(open, crashed);
		assert.deepStrictEqual(action, {
			_tag: "Start",
			project: "/work/demlik",
			stale: {reason: "the desk it names (pid 4242) does not answer", pid: 4242},
		});
	});
});
