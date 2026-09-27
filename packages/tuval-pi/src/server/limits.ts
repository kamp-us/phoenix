/**
 * The two bounds a connection is closed for crossing, and the close codes they close under.
 * Both are the production adapter's addition: the spike server had neither (#7465).
 */

/** Close codes are RFC 6455 §7.4.1; `ws` refuses anything outside 1000/3000-4999 on `close`. */
export const CLOSE_FRAME_TOO_LARGE = 1009;
export const CLOSE_QUEUE_OVERFLOW = 1013;
export const CLOSE_PROTOCOL_VIOLATION = 1002;
export const CLOSE_INTERNAL = 1011;

export interface PiServerLimits {
	/**
	 * Upper bound on one framed CBOR payload arriving from a client, handed to
	 * `ClientMessageDecoder`. Outbound frames are the protocol's own default: this bound exists to
	 * stop a client claiming a huge length, and capping our own snapshots with it would make a long
	 * transcript unsendable rather than safe.
	 */
	readonly maxInboundFrameLength: number;
	/** Upper bound on frames queued for one connection's writer before it is closed. */
	readonly maxOutboundFrames: number;
}

/**
 * A Pi transcript snapshot is the largest frame either side sends and grows with the
 * conversation, so the frame bound is generous and the queue bound is what actually catches a
 * client that stops reading: a stalled socket fills the queue long before one frame gets big.
 */
export const defaultLimits: PiServerLimits = {
	maxInboundFrameLength: 8 * 1024 * 1024,
	maxOutboundFrames: 256,
};
