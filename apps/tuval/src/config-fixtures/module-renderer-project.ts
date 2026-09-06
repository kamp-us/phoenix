export default {
	version: 1,
	programs: [
		{id: "b", renderer: {kind: "module", ref: "@shared/win/window"}},
		{id: "c", renderer: {kind: "module", ref: "@project/win/window"}},
		{id: "d", renderer: {kind: "host-native", ref: "not-a-module"}},
	],
};
