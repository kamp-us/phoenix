export default {
	contractVersion: 1,
	kind: "edge",
	render(props, api) {
		const distance = Math.abs(props.targetX - props.sourceX);
		const control = Math.max(48, distance * 0.42);
		const path = `M ${props.sourceX} ${props.sourceY} C ${props.sourceX + control} ${props.sourceY - 64}, ${props.targetX - control} ${props.targetY + 64}, ${props.targetX} ${props.targetY}`;
		return api.createElement(
			"g",
			{"data-package": "fixture-plain-pi"},
			api.createElement("path", {
				className: "fixture-package-edge",
				d: path,
				fill: "none",
				stroke: "var(--accent)",
				strokeWidth: 4,
			}),
		);
	},
};
