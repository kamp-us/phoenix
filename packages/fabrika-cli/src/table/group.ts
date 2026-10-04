/**
 * A group row: one project row that stands for several issues.
 *
 * Two kinds exist. An **epic** row's members are its open sub-issues. A **chain** row's members are
 * the row's open `blocked_by` issues, followed transitively through open issues only. Membership is
 * read off GitHub's native graph every time it is asked for and never stored, so it cannot drift
 * from the graph: a member that closes is simply not derived on the next read.
 *
 * This is the one place membership is decided. Sync sums a group's spend and asks with it, and the
 * flag, prep and bet-approval slices import the same {@link groupOf}, so no two of them can
 * disagree about which issues a row stands for.
 *
 * A blocker two chains share is a member of both: nothing here limits an issue to one group.
 *
 * **A bet keeps its own row.** A row whose Stage is `bet` is a member of no other row's group: an
 * epic row leaves a bet sub-issue out, and a chain stops at a bet blocker without walking on to that
 * blocker's own blockers. The bet row still heads its own group, so its spend is counted once, on
 * the bet. An issue that also reaches the head by a path with no bet on it is still a member.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9856#issuecomment-5852710907
 * @ruling https://github.com/kamp-us/phoenix/issues/9972#issuecomment-5974135601
 */

/** What the graph says about one issue, as far as groups are concerned. */
export interface IssueNode {
	readonly number: number;
	readonly open: boolean;
	/** The issue it hangs under as a sub-issue, or `null`. */
	readonly parent: number | null;
	readonly subIssues: ReadonlyArray<number>;
	readonly blockedBy: ReadonlyArray<number>;
}

export type IssueGraph = ReadonlyMap<number, IssueNode>;

/** The issues whose row's Stage is `bet`. Read off the table, since the issue graph cannot say. */
export type Bets = ReadonlySet<number>;

export const graphOf = (nodes: Iterable<IssueNode>): IssueGraph =>
	new Map([...nodes].map((node) => [node.number, node] as const));

export type GroupKind = "epic" | "chain";

export type Group =
	/** A row that stands for itself alone. */
	| {readonly _tag: "Single"; readonly head: number}
	/**
	 * An epic row. Its members may be empty, once every sub-issue has closed: the row is still the
	 * epic's, it just sums nothing but itself.
	 */
	| {readonly _tag: "Epic"; readonly head: number; readonly members: ReadonlyArray<number>}
	/** A chain row. A row with no open blocker is `Single`, so a chain always has a member. */
	| {
			readonly _tag: "Chain";
			readonly head: number;
			readonly members: readonly [number, ...ReadonlyArray<number>];
	  };

export type Membership =
	| {readonly _tag: "Derived"; readonly group: Group}
	/** The graph lacks these nodes, so membership is not decidable yet. Read them and ask again. */
	| {readonly _tag: "Incomplete"; readonly missing: ReadonlyArray<number>};

export const kindOf = (group: Group): GroupKind | null =>
	group._tag === "Epic" ? "epic" : group._tag === "Chain" ? "chain" : null;

export const membersOf = (group: Group): ReadonlyArray<number> =>
	group._tag === "Single" ? [] : group.members;

/** The head first, then every member: the issues whose numbers a group row sums. */
export const issuesOf = (group: Group): ReadonlyArray<number> => [group.head, ...membersOf(group)];

const ascending = (numbers: Iterable<number>): number[] => [...numbers].sort((a, b) => a - b);

const incomplete = (missing: Iterable<number>): Membership => ({
	_tag: "Incomplete",
	missing: ascending(new Set(missing)),
});

const epicOf = (head: IssueNode, graph: IssueGraph, bets: Bets): Membership => {
	const own = head.subIssues.filter((child) => !bets.has(child));
	const missing = own.filter((child) => !graph.has(child));
	if (missing.length > 0) return incomplete(missing);
	const members = own.filter((child) => graph.get(child)?.open === true);
	return {_tag: "Derived", group: {_tag: "Epic", head: head.number, members: ascending(members)}};
};

const chainOf = (head: IssueNode, graph: IssueGraph, bets: Bets): Membership => {
	const members = new Set<number>();
	const missing = new Set<number>();
	const queue = [...head.blockedBy];
	while (queue.length > 0) {
		const next = queue.shift() as number;
		if (next === head.number || members.has(next) || bets.has(next)) continue;
		const node = graph.get(next);
		if (node === undefined) {
			missing.add(next);
			continue;
		}
		if (!node.open) continue;
		members.add(next);
		queue.push(...node.blockedBy);
	}
	if (missing.size > 0) return incomplete(missing);
	const [first, ...rest] = ascending(members);
	return {
		_tag: "Derived",
		group:
			first === undefined
				? {_tag: "Single", head: head.number}
				: {_tag: "Chain", head: head.number, members: [first, ...rest]},
	};
};

/**
 * The group `head`'s row stands for, derived from the graph alone. An issue with sub-issues heads
 * an epic row; otherwise one with an open blocker heads a chain row; otherwise it stands alone.
 * No issue in `bets` is a member, whichever row is asked about; `head` may itself be one.
 */
export const groupOf = (head: number, graph: IssueGraph, bets: Bets): Membership => {
	const node = graph.get(head);
	if (node === undefined) return incomplete([head]);
	return node.subIssues.length > 0 ? epicOf(node, graph, bets) : chainOf(node, graph, bets);
};
