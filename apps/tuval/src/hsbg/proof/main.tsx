import "@manti-ui/styles/index.css";
import {Button} from "@kampus/design";
import {useState} from "react";
import {createRoot} from "react-dom/client";
import {
	defaultHSBGState,
	type HSBGMinion,
	type HSBGSpectatorState,
} from "../../../../../packages/tuval-hsbg/src/hsbg-state.ts";
import {HSBGSpectatorView} from "../../../../../packages/tuval-hsbg/src/window.tsx";
import "@kampus/design/tokens.css";
import "@kampus/design/fonts.css";

const minion = (
	id: string,
	card_id: string,
	name: string,
	attack: number,
	health: number,
	tier: number,
	extra: Partial<HSBGMinion> = {},
): HSBGMinion => ({id, card_id, name, attack, health, tier, tribe: "Mech", ...extra});
const board = [
	minion("p1", "BGS_071", "Deflect-o-Bot", 12, 9, 3, {divine_shield: true}),
	minion("p2", "BOT_312", "Replicating Menace", 8, 6, 3),
	minion("p3", "EX1_556", "Harvest Golem", 7, 9, 2),
	minion("p4", "GVG_113", "Foe Reaper 4000", 18, 22, 6),
	minion("p5", "BOT_911", "Annoy-o-Module", 4, 8, 4, {divine_shield: true, taunt: true}),
	minion("p6", "ULD_217", "Micro Mummy", 5, 8, 1, {reborn: true}),
	minion("p7", "BGS_012", "Kangor’s Apprentice", 3, 6, 6, {tribe: "Neutral"}),
];
const sample: HSBGSpectatorState = {
	...defaultHSBGState,
	streamUrl: "sample-room",
	isConnected: true,
	turn: 9,
	p1: {
		name: "Millhouse Manastorm",
		hp: 28,
		armor: 5,
		gold: 10,
		max_gold: 10,
		tavern_tier: 5,
		tavern_upgrade_cost: 8,
		board,
		shop: [
			minion("s1", "GVG_096", "Piloted Shredder", 4, 3, 3),
			minion("s2", "BOT_312", "Replicating Menace", 3, 1, 3),
			minion("s3", "BGS_071", "Deflect-o-Bot", 3, 2, 3, {divine_shield: true}),
			minion("s4", "BOT_911", "Annoy-o-Module", 2, 4, 4, {divine_shield: true, taunt: true}),
			minion("s5", "GVG_113", "Foe Reaper 4000", 6, 9, 6),
			minion("s6", "EX1_556", "Harvest Golem", 2, 3, 2),
			minion("s7", "GAME_005", "Tavern Coin", 0, 0, 1, {
				card_type: "SPELL",
				tribe: "Tavern Spell",
				cost: 0,
			}),
		],
		opponent_hero: "The Lich King",
		opponent_board: board.map((m, i) => ({
			...m,
			id: `e${i}`,
			attack: m.attack + 3,
			health: m.health + 2,
			reborn: i === 0,
		})),
	},
	best_line: {
		score: 8.7,
		confidence: 0.84,
		actions: [
			"Buy Annoy-o-Module and magnetize it onto Foe Reaper 4000.",
			"Buy Replicating Menace to refresh your Divine Shields.",
			"Keep Deflect-o-Bot first. Protect Kangor’s Apprentice at the end.",
		],
	},
	runner_up: {
		score: 7.2,
		confidence: 0.68,
		actions: ["Upgrade to Tavern Tier 6.", "Save your remaining gold for the next recruit phase."],
	},
};
function Proof() {
	const [state, setState] = useState(sample);
	const [connection, setConnection] = useState("");
	return (
		<>
			<div
				style={{
					padding: "12px 20px",
					display: "flex",
					alignItems: "center",
					gap: 12,
					background: "var(--surface)",
					color: "var(--text-primary)",
					borderBottom: "1px solid var(--border)",
				}}
			>
				<strong>Sample match · visual verification</strong>
				<Button variant="secondary" onClick={() => setState(sample)}>
					Recruit
				</Button>
				<Button variant="secondary" onClick={() => setState({...sample, phase: "COMBAT"})}>
					Combat
				</Button>
				<Button variant="secondary" onClick={() => setState(defaultHSBGState)}>
					Empty
				</Button>
				<Button
					variant="secondary"
					onClick={() => setState({...sample, isConnected: false, error: "Bridge unavailable"})}
				>
					Disconnected
				</Button>
				<span>{connection}</span>
			</div>
			<div style={{height: "calc(100vh - 61px)"}}>
				<HSBGSpectatorView
					state={state}
					onConnect={(url) => setConnection(`Connection input received: ${url}`)}
				/>
			</div>
		</>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing proof root");
createRoot(root).render(<Proof />);
