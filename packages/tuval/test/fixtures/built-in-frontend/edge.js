export default {
	contractVersion: 1,
	kind: "edge",
	render() {
		throw new Error("a built-in edge key must never execute package code");
	},
};
