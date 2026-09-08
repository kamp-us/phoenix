/** Local exception retention; see .patterns/backend-exception-translation.md. */
export const retaining = <E extends Error>(cause: unknown, error: E): E => {
	error.cause = cause;
	return error;
};
