type Tokens = {readonly inputTokens: number; readonly outputTokens: number};

// Codex sends running thread totals. Tuval accepts one complete report per turn.
export class TurnUsage {
	private previous: Tokens | undefined;
	private readonly turns = new Map<string, Tokens>();

	record(turn: string, total: Tokens, last: Tokens): void {
		const delta =
			this.previous === undefined
				? last
				: {
						inputTokens: Math.max(0, total.inputTokens - this.previous.inputTokens),
						outputTokens: Math.max(0, total.outputTokens - this.previous.outputTokens),
					};
		this.previous = total;
		const current = this.turns.get(turn);
		this.turns.set(turn, {
			inputTokens: (current?.inputTokens ?? 0) + delta.inputTokens,
			outputTokens: (current?.outputTokens ?? 0) + delta.outputTokens,
		});
	}

	finish(turn: string): Tokens | undefined {
		const tokens = this.turns.get(turn);
		this.turns.delete(turn);
		return tokens;
	}
}
