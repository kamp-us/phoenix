/**
 * The shared `Report` test double. Fail-on-contact, not silently-succeed: an
 * un-overridden method dies if reached, which is what proves the path under test touched
 * only the methods it was scripted with. A factory, not a shared instance
 * (`.patterns/effect-testing.md`).
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
	listResolved: die("listResolved"),
	resolveTarget: die("resolveTarget"),
	reopenForTarget: die("reopenForTarget"),
	reopenForWave: die("reopenForWave"),
	waveTargets: die("waveTargets"),
	lookupReportTarget: die("lookupReportTarget"),
	firstOpenReportId: die("firstOpenReportId"),
	countRemovalsByAuthors: die("countRemovalsByAuthors"),
	reporterDiversity: die("reporterDiversity"),
	productionCountsByAuthors: die("productionCountsByAuthors"),
	countOpenReportedTargetsByAuthors: die("countOpenReportedTargetsByAuthors"),
};

export const makeReportStub = (overrides: Partial<ReportShape> = {}): Layer.Layer<Report> =>
	Layer.succeed(Report, {...failOnContact, ...overrides});
