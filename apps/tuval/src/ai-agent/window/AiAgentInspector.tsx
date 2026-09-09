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
import {type AgentAccount, type AiAgentSessionState, usageTotals} from "../core/index.ts";
import {isAiAgentSessionState} from "../core/snapshot.ts";
import {agentCost} from "../self-report.ts";
import "./ai-agent-inspector.css";

const tokens = new Intl.NumberFormat("en-US");

/** Before `start` answers there is no session id, and an empty slot would read as a lost one. */
const NO_SESSION_YET = "no session yet";

/**
 * The booted-on account as one line, or `null` when there is nothing to say.
 *
 * Both fields of `AgentAccount` are optional and either can stand alone, so the answer is what is
 * present joined rather than a fixed `org · plan` template — an API-key login reports a plan and no
 * organization, and a template would render a leading separator against nothing.
 */
const accountLine = (account: AgentAccount | null): string | null => {
	if (account === null) return null;
	const parts = [account.organization, account.subscriptionType].filter(
		(part): part is string => part !== undefined && part !== "",
	);
	return parts.length === 0 ? null : parts.join(" · ");
};

/** The rows this panel shows, in the order it shows them. */
const inspectorRows = (
	state: AiAgentSessionState,
): ReadonlyArray<readonly [label: string, value: string, className?: string]> => {
	const usage = usageTotals(state.usage);
	const account = accountLine(state.account);
	return [
		["Cost", agentCost(usage.cost), "tuval-agent-inspector-number"],
		["Input tokens", tokens.format(usage.inputTokens), "tuval-agent-inspector-number"],
		["Output tokens", tokens.format(usage.outputTokens), "tuval-agent-inspector-number"],
		["Session", state.sessionId ?? NO_SESSION_YET, "tuval-agent-inspector-wrap"],
		["Directory", state.cwd, "tuval-agent-inspector-wrap"],
		// Omitted rather than shown empty: unlike the session id, an absent version is not a state
		// the operator has to be told about — the layer reports one as the session opens.
		...(state.agentVersion === null
			? []
			: [["Version", state.agentVersion] as readonly [string, string]]),
		// The label carries "booted on" because that is the whole claim: the SDK answers the account
		// cached at the first connect and never re-reads it, so a row saying plain "Account" would
		// promise a currency this value does not have (#8447). Omitted on the version row's rule.
		...(account === null
			? []
			: [["Account (booted on)", account, "tuval-agent-inspector-wrap"] as const]),
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
