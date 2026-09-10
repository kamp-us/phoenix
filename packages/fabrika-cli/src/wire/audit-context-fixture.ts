/** One complete research record for wire conformance and the grill transport tests. */
export const AUDIT_FIELDS = JSON.stringify({
	version: 1,
	runId: "audit-run-20260910",
	repository: "o/r",
	folder: "packages/tool",
	revision: "a".repeat(40),
	date: "2026-09-10",
	predecessor: null,
	findings: [
		{
			id: "F1",
			workflow: "A reviewer saves a screenshot",
			friction: "Saving failures advise repairing the page",
			evidence: ["One catch handles navigation and file writes"],
			locations: ["src/capture.ts:42"],
			uncertainty: "Source inference; no production reproduction",
			counterargument: "The shared catch keeps the caller small",
			severity: "Recovery sends the user to the wrong action",
			ranking: "First because the wrong action repeats",
			recommendation: "Separate capture from storage errors",
			dependencyCategory: "Local collaborator",
			benefit: "One place chooses the recovery action",
			ownership: "No current owner after two searches",
			uncoveredScope: "The screenshot writer and its caller",
		},
	],
	disproven: [
		{suspicion: "Header-only image validation", disposition: "Decoder already validates the image"},
	],
	accounting: {
		openedFiles: ["src/capture.ts"],
		searches: ["saveScreenshot across src"],
		coverage: ["error ownership checked in capture"],
		limits: ["No test ownership census"],
	},
	firstQuestion: {
		findingId: "F1",
		question: "Should recovery distinguish storage failures?",
		recommendation: "Yes; keep both error decisions at the capture interface",
	},
});
