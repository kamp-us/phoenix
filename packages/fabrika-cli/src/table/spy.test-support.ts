/** A board whose every method call is logged by name, in call order, before it runs. */
export const spy = <B extends object>(board: B): {readonly board: B; readonly calls: string[]} => {
	const calls: string[] = [];
	const wrapped = Object.fromEntries(
		Object.entries(board).map(([name, method]) => [
			name,
			(...args: ReadonlyArray<unknown>) => {
				calls.push(name);
				return (method as (...args: ReadonlyArray<unknown>) => unknown)(...args);
			},
		]),
	) as B;
	return {board: wrapped, calls};
};
