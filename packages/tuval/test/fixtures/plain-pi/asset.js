export default {
	contractVersion: 1,
	kind: "node",
	render(_props, api) {
		return api.createElement(
			"article",
			{className: "fixture-package-node", "aria-label": "Fixture paket düğümü"},
			api.createElement("strong", null, "Paket tuvali"),
			api.createElement("span", null, "fixture.node özel düğümü"),
		);
	},
};
