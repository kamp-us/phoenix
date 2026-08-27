import {createFateServer} from "@nkzw/fate/server";
import type {DiscoveryOutcome} from "../shared/discovery.js";

const noSources = {
	registry: new Map(),
	getSource: (): never => {
		throw new Error("Tuval discovery has no entity sources");
	},
};

export const makeFateServer = (discover: () => Promise<DiscoveryOutcome>) =>
	createFateServer({
		roots: {},
		sources: noSources,
		queries: {
			discovery: {
				type: "TuvalDiscovery",
				resolve: discover,
			},
		},
	});
