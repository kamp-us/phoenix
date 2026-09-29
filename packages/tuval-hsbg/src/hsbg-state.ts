export interface HSBGMinion {
	readonly id: string;
	readonly card_id: string;
	readonly name: string;
	readonly attack: number;
	readonly health: number;
	readonly tier: number;
	readonly tribe?: string;
	readonly cost?: number;
	readonly card_type?: string;
	readonly divine_shield?: boolean;
	readonly taunt?: boolean;
	readonly poisonous?: boolean;
	readonly reborn?: boolean;
}

export interface HSBGPlayerState {
	readonly name: string;
	readonly hp: number;
	readonly armor: number;
	readonly gold: number;
	readonly max_gold: number;
	readonly tavern_tier: number;
	readonly tavern_upgrade_cost: number;
	readonly board: ReadonlyArray<HSBGMinion>;
	readonly shop: ReadonlyArray<HSBGMinion>;
	readonly opponent_board?: ReadonlyArray<HSBGMinion>;
	readonly opponent_hero?: string;
	readonly opponent_hero_hp?: number;
	readonly opponent_hero_armor?: number;
	readonly opponent_hero_tier?: number;
}

export interface HSBGAdviceLine {
	readonly actions: ReadonlyArray<string>;
	readonly score: number;
	readonly confidence: number;
	readonly source?: string;
}

export interface HSBGSpectatorState {
	readonly streamUrl: string;
	readonly isConnected: boolean;
	readonly error: string | null;
	readonly turn: number;
	readonly phase: "RECRUIT" | "COMBAT";
	readonly p1: HSBGPlayerState;
	readonly best_line: HSBGAdviceLine | null;
	readonly runner_up: HSBGAdviceLine | null;
}

export const isHSBGSpectatorState = (value: unknown): value is HSBGSpectatorState =>
	typeof value === "object" &&
	value !== null &&
	"streamUrl" in value &&
	typeof value.streamUrl === "string" &&
	"turn" in value &&
	typeof value.turn === "number" &&
	"p1" in value &&
	typeof value.p1 === "object" &&
	value.p1 !== null;

export const defaultHSBGState: HSBGSpectatorState = {
	streamUrl: "http://localhost:7860",
	isConnected: false,
	error: null,
	turn: 1,
	phase: "RECRUIT",
	p1: {
		name: "Live Player",
		hp: 30,
		armor: 0,
		gold: 3,
		max_gold: 3,
		tavern_tier: 1,
		tavern_upgrade_cost: 5,
		board: [],
		shop: [],
	},
	best_line: null,
	runner_up: null,
};
