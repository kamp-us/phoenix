/**
 * `makeReportStub` — the shared `Report` test double. Defaults every one of the
 * `Report` methods to fail-on-contact (`Effect.die`) and takes a partial override
 * of the method(s) under test, returning the `Layer.succeed(Report, …)` layer. One
 * place the interface shape lives — adding a method to `Report` is a single edit
 * here, not shotgun surgery across every hand-rolled stub.
 *
 * A `layerStub` (fail-on-contact), not a `layerNoop` (silently-succeed): an
 * un-overridden method, if reached, dies and fails the test — the discipline that
 * proves the path under test touched only the method(s) it was scripted with.
 *
 * A **factory, not a shared instance** (`.patterns/effect-testing.md`).
 */
import {Effect, Layer} from "effect";
import {Report} from "./Report.ts";

type ReportShape = typeof Report.Service;

const die =
	(method: string) =>
	(..._args: ReadonlyArray<unknown>): Effect.Effect<never, never, never> =>
		Effect.die(new Error(`Report.${method} touched an unexpected method`));

const failOnContact: ReportShape = {
	submit: die("submit"),
	readByReporter: die("readByReporter"),
	listOpen: die("listOpen"),
	resolveTarget: die("resolveTarget"),
	reopenForTarget: die("reopenForTarget"),
	reopenForWave: die("reopenForWave"),
	lookupReportTarget: die("lookupReportTarget"),
	firstOpenReportId: die("firstOpenReportId"),
	countRemovalsByAuthors: die("countRemovalsByAuthors"),
	reporterDiversity: die("reporterDiversity"),
	productionCountsByAuthors: die("productionCountsByAuthors"),
	countOpenReportedTargetsByAuthors: die("countOpenReportedTargetsByAuthors"),
};

export const makeReportStub = (overrides: Partial<ReportShape> = {}): Layer.Layer<Report> =>
	Layer.succeed(Report, {...failOnContact, ...overrides});
