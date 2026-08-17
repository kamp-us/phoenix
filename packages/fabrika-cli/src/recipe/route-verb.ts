/**
 * `recipe route` — what a chore drive does at one chore-lane state, before and after the run.
 *
 * One question asked twice. Without `--exit` the answer is which recipe verb the state applies and
 * what that verb is pointed at; with `--exit` it is the single machine event that run's outcome
 * records. Both halves come off [`drive.ts`](./drive.ts)'s tables, so `operate`'s chore drive relays
 * an answer this package owns instead of carrying a routing table in prose (ADR 0228) — a prose copy
 * of an exit table is a copy that drifts from the exits the moment either verb grows a code.
 */
import {Effect} from "effect";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {NO_RECIPE} from "./codes.ts";
import {dispositionOf, RECIPE_ROUTES, routeOf} from "./drive.ts";

const VERB = "fabrika recipe route";

export interface RouteOptions {
	/** The chore lane's leaf state, exactly as `lane status` prints it. */
	readonly state: string;
	/** The exit the state's recipe run answered on; `null` asks the routing half instead. */
	readonly exit: number | null;
}

export const runRoute = (options: RouteOptions): Effect.Effect<VerbOutcome> =>
	Effect.sync(() => {
		const route = routeOf(options.state);
		if (route === null) {
			return refuse(
				NO_RECIPE,
				`${VERB}: state "${options.state}" applies no recipe — act on that state, do not run a verb.`,
				[`${VERB}: the states that route are ${RECIPE_ROUTES.map((row) => row.state).join(", ")}.`],
			);
		}
		if (options.exit === null) {
			return answer(
				JSON.stringify({
					state: route.state,
					verb: route.verb,
					target: route.target,
					summary: route.summary,
				}),
				[
					`${VERB}: state "${route.state}" applies \`fabrika recipe ${route.verb}\` to the ${route.target} it is pointed at.`,
				],
			);
		}
		const folded = dispositionOf(route.verb, options.exit);
		return answer(
			JSON.stringify({
				state: route.state,
				verb: route.verb,
				exit: options.exit,
				event: folded.event,
				why: folded.why,
			}),
			[`${VERB}: exit ${options.exit} records ${folded.event} — ${folded.why}.`],
		);
	});
