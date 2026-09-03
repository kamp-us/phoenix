import {Effect, Option} from "effect";
import {boot, defaultConfigModule, defaultStateDir} from "./boot.ts";
import {ProcessTablePort} from "./table/ProcessTablePort.ts";
import type {TableRow} from "./table/row.ts";

const configModule = process.argv[2] ?? defaultConfigModule;
const stateDir = process.argv[3] ?? defaultStateDir;

/** One table row as the terminal shows it: the port's row, nothing program-specific. */
export const renderRow = (row: TableRow): string => {
	const parent = Option.getOrElse(row.parentId, () => "-");
	const ports = Object.entries(row.ports)
		.map(([name, port]) => `${name}:${port.direction}(${port.kind})`)
		.join(",");
	return `tuval: process ${row.id} program=${row.programId} parent=${parent} ports=${ports || "-"} state=${row.stateSummary.lifecycle}@${row.stateSummary.revision}`;
};

/**
 * Resolves on SIGINT or SIGTERM; the Scope closing after it is the clean stop. Listening starts
 * here, before boot, so a signal that lands between "running" and the wait still stops cleanly.
 */
const stopRequested = new Promise<void>((resolve) => {
	process.once("SIGINT", () => resolve());
	process.once("SIGTERM", () => resolve());
});

/** Signal listeners alone do not keep Node's loop alive (exit 13, unsettled top-level await); a timer does. */
const waitForStop = Effect.callback<void>((resume) => {
	const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
	void stopRequested.then(() => {
		clearInterval(keepAlive);
		resume(Effect.void);
	});
});

const run = Effect.gen(function* () {
	const {report, kernel} = yield* boot({configModule, stateDir});
	console.log(
		`tuval: booted — ${report.programCount} program(s) registered from ${report.configModule}; ${report.processCount} process(es) live, ${report.restoredCount} restored from ${report.stateDir}`,
	);
	const rows = yield* ProcessTablePort.use((port) => port.rows).pipe(Effect.provideContext(kernel));
	for (const row of rows) console.log(renderRow(row));
	if (rows.length === 0) return 0;
	console.log("tuval: running — Ctrl-C stops and checkpoints");
	yield* waitForStop;
	console.log("tuval: stopping");
	return 0;
});

process.exitCode = await Effect.runPromise(
	run.pipe(
		Effect.catch((error) => {
			console.error(`tuval: refusing to boot — ${error.message}`);
			return Effect.succeed(1);
		}),
		Effect.scoped,
	),
);
