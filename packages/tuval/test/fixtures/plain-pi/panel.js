export default {
	contractVersion: 1,
	kind: "panel",
	render(_props, api) {
		return api.createElement(
			"section",
			{className: "fixture-package-panel", "aria-label": "Fixture paket paneli"},
			api.createElement("strong", null, "Paket paneli"),
			api.createElement("span", null, "fixture.panel sağlıklı"),
		);
	},
};
