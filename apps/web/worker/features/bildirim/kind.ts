/**
 * The closed notification-kind discriminant, and the one runtime tuple every emitter const
 * and the client copy map source from. The client `KIND_COPY` map is `satisfies
 * Record<NotificationKind, …>`, so shipping a new kind without its Turkish copy is a compile
 * error rather than a raw wire identifier rendered to a reader (the `reply` drift, #2016).
 *
 * `vote` is the aggregated live-content vote moment, kept DISTINCT from divan's sandboxed
 * `divan-vote` so the two surfaces carry their own product voice.
 */

export const NOTIFICATION_KINDS = [
	"divan-vote",
	"kefil",
	"terfi",
	"reply",
	"vote",
	"report-filed",
	"caylak-pending",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
