/**
 * What a batch keeps between runs: only its idempotency ledger. A batch interrupted mid-render
 * reloads as an idle machine holding the ledger, never as a half-finished batch to resume.
 */
import {Refusal, type Store} from "@demlik/tea";
import {fileStore} from "@demlik/tea/node";
import {Option} from "effect";
import * as Schema from "effect/Schema";
import type {Ledger, State} from "./machine.ts";

const LedgerSchema = Schema.Struct({
	entries: Schema.Record(
		Schema.String,
		Schema.Struct({value: Schema.Struct({video: Schema.String}), atMs: Schema.Number}),
	),
	order: Schema.Array(Schema.String),
	capacity: Schema.optionalKey(Schema.Number),
	ttlMs: Schema.optionalKey(Schema.Number),
});

/** A file that is not a ledger loads as no ledger, so the next batch renders everything. */
export const parseLedger = (raw: unknown): Ledger | null =>
	Option.getOrNull(Schema.decodeUnknownOption(LedgerSchema)(raw));

export const ledgerStore = (path: string): Store<State> => {
	const file = fileStore<Ledger>(path, parseLedger);
	return {
		load: () => file.load(),
		save: (state) => file.save(state.ledger),
		migrate: (raw) => {
			const ledger = file.migrate(raw);
			return ledger === null || ledger instanceof Refusal ? ledger : {type: "idle", ledger};
		},
	};
};
