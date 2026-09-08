/**
 * What every ai-agent backend shows in the desk inspector: the five facts the chat bar used to
 * carry (founder ruling 2026-09-05, #8190) — cost, input tokens, output tokens, the session id and
 * the working directory — plus the version the layer reports for whatever it is driving (#7955).
 *
 * One renderer for both backends rather than one each. The Claude window's usage and session lines
 * and the Pi window's usage line were the same values written three times, once per surface
 * (#7956); they all read `AiAgentSessionState`, which both rows run, so there was never a per-agent
 * fact among them. Both program rows declare `AI_AGENT_INSPECTOR_REF` and this is what it answers.
 *
 * Two things are deliberate and not obvious.
 *
 * **It is not a live region.** Cost and token counts move on every usage event of a running turn,
 * and a `role="status"` here would narrate the whole turn to a screen-reader user. It is a
 * description list of plain text instead: reachable on demand, silent while it changes.
 *
 * **The path is not truncated.** An ellipsis would hide the tail of a project path with nothing to
 * reveal it; the panel is a column, so a long path takes another line rather than losing its end.
 */

import {EmptyState} from "@kampus/design";
import {Effect, Fiber, Stream} from "effect";
import type {ReactElement} from "react";
import {useEffect, useState} from "react";
import type {AnyInspectorRenderer} from "../../shell/desk/index.ts";
import {inspectorRenderer} from "../../shell/desk/index.ts";
import type {AnyWindowHost} from "../../shell/window/index.ts";
import {type AiAgentSessionState, usageTotals} from "../core/index.ts";
import {isAiAgentSessionState} from "../core/snapshot.ts";
import "./ai-agent-inspector.css";

/**
 * The SDK and Pi's adapter both report a currency amount already scaled to dollars, so `cost` needs
 * no conversion here. Four fraction digits because a single turn routinely costs well under a cent,
 * and a session that reads `$0.00` after ten turns says nothing.
 */
const money = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 4,
});

const tokens = new Intl.NumberFormat("en-US");

/** Before `start` answers there is no session id, and an empty slot would read as a lost one. */
const NO_SESSION_YET = "no session yet";

/** The rows this panel shows, in the order it shows them. */
const inspectorRows = (
	state: AiAgentSessionState,
): ReadonlyArray<readonly [label: string, value: string, className?: string]> => {
	const usage = usageTotals(state.usage);
	return [
		["Cost", money.format(usage.cost)],
		["Input tokens", tokens.format(usage.inputTokens)],
		["Output tokens", tokens.format(usage.outputTokens)],
		["Session", state.sessionId ?? NO_SESSION_YET, "tuval-agent-inspector-wrap"],
		["Directory", state.cwd, "tuval-agent-inspector-wrap"],
		// Omitted rather than shown empty: unlike the session id, an absent version is not a state
		// the operator has to be told about — the layer reports one as the session opens.
		...(state.agentVersion === null
			? []
			: [["Version", state.agentVersion] as readonly [string, string]]),
	];
};

function AiAgentInspectorPanel({state}: {readonly state: AiAgentSessionState}): ReactElement {
	return (
		// `fieldset` + `legend` is the group, not a `div` with `role="group"` and not the `dl` itself:
		// a `dl` carries list semantics an ARIA role would override, and a bare role where a semantic
		// element exists is what `a11y/useSemanticElements` refuses. The legend is hidden because the
		// panel already carries the word Inspector above it — the name is for the reader who jumps
		// here, and a second visible heading would say the same thing twice.
		<fieldset className="tuval-agent-inspector">
			<legend className="kp-visually-hidden">Agent session</legend>
			<dl className="tuval-agent-inspector-list">
				{inspectorRows(state).map(([label, value, className]) => (
					<div className="tuval-agent-inspector-row" key={label}>
						<dt className="tuval-agent-inspector-label">{label}</dt>
						<dd className={className ?? undefined}>{value}</dd>
					</div>
				))}
			</dl>
		</fieldset>
	);
}

/**
 * The panel over a live process. It subscribes to the same `readProcess` a window renderer does and
 * reads nothing else — no store, no fetch, no socket.
 *
 * The state is admitted before it is read, for the reason `../../page/readable-state.tsx` gives: a
 * kernel a shape older than this page would otherwise throw inside React's render. There is no
 * `readsState` here because that wraps a *window* renderer; the check is the same one, applied at
 * the one place an inspector reads.
 */
function AiAgentInspectorView({host}: {readonly host: AnyWindowHost}): ReactElement {
	const [state, setState] = useState<AiAgentSessionState | null>(null);
	const read = host.readProcess;
	useEffect(() => {
		const fiber = Effect.runFork(
			Stream.runForEach(read, (view) =>
				Effect.sync(() => {
					if (view._tag === "Live" && isAiAgentSessionState(view.state)) setState(view.state);
				}),
			),
		);
		return () => void Effect.runFork(Fiber.interrupt(fiber));
	}, [read]);
	if (state === null) {
		return (
			<EmptyState
				title="Nothing to inspect yet"
				description="This window's process has sent no session state the inspector can read."
			/>
		);
	}
	return <AiAgentInspectorPanel state={state} />;
}

/** The renderer `AI_AGENT_INSPECTOR_REF` names: what a page's inspector table binds. */
export const AiAgentInspector: AnyInspectorRenderer = inspectorRenderer(
	"host-native",
	(host: AnyWindowHost) => <AiAgentInspectorView host={host} />,
);
