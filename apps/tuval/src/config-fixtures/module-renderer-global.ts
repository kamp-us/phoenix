export default {
	version: 1,
	programs: [
		{id: "a", renderer: {kind: "module", ref: "@global/win/window"}},
		{id: "b", renderer: {kind: "module", ref: "@shared/win/window"}},
	],
};
