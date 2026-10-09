import {Refusal} from "@demlik/tea";
import {initStore, remember} from "@demlik/tea/idempotency";
import {describe, expect, it} from "vitest";
import {ledgerStore, parseLedger} from "./ledger.ts";
import type {Rendered} from "./machine.ts";

const ledger = remember(initStore<Rendered>({capacity: 10}), "hash", {video: "out/a.mp4"}, 1);

describe("ledgerStore", () => {
	it("reloads a saved ledger as an idle machine", () => {
		const migrated = ledgerStore("unused.json").migrate(JSON.parse(JSON.stringify(ledger)));
		expect(migrated).toEqual({type: "idle", ledger});
	});

	it("loads nothing saved as no state", () => {
		expect(ledgerStore("unused.json").migrate(null)).toBeNull();
	});

	it("reads a file that is not a ledger as no ledger, so the batch renders everything", () => {
		expect(parseLedger({type: "rendering"})).toBeNull();
		expect(ledgerStore("unused.json").migrate({type: "rendering"})).not.toBeInstanceOf(Refusal);
	});
});
