/** The one port kind the two demo programs share: a count, as a non-negative integer. */

export const COUNT_KIND = "count/v1";

export const isCount = (payload: unknown): payload is number =>
	typeof payload === "number" && Number.isInteger(payload) && payload >= 0;
