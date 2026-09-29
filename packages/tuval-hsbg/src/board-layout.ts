import type {HSBGMinion, HSBGSpectatorState} from "./hsbg-state.ts";

export interface BoardSlot {
	readonly key: string;
	readonly row: "upper" | "player";
	readonly index: number;
	readonly x: number;
	readonly z: number;
	readonly minion: HSBGMinion | null;
}

export function boardSlots(state: HSBGSpectatorState): ReadonlyArray<BoardSlot> {
	const upper = state.phase === "COMBAT" ? (state.p1.opponent_board ?? []) : state.p1.shop;
	return (
		[
			["upper", upper],
			["player", state.p1.board],
		] as const
	).flatMap(([row, minions]) => {
		const count = Math.max(7, minions.length);
		const spacing = Math.min(2, 12 / (count - 1));
		return Array.from({length: count}, (_, index) => ({
			key: `${row}-${index}`,
			row,
			index,
			x: (index - (count - 1) / 2) * spacing,
			z: row === "upper" ? -2.1 : 2.1,
			minion: minions[index] ?? null,
		}));
	});
}

export function minionAbilities(minion: HSBGMinion): ReadonlyArray<string> {
	return [
		minion.divine_shield && "Divine Shield",
		minion.taunt && "Taunt",
		minion.reborn && "Reborn",
		minion.poisonous && "Poisonous",
	].filter((ability): ability is string => Boolean(ability));
}

export const cardArtUrl = (cardId: string): string =>
	`https://art.hearthstonejson.com/v1/256x/${encodeURIComponent(cardId)}.jpg`;
