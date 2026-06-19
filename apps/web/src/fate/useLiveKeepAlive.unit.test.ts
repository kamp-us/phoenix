import {type ConnectionMetadata, ConnectionTag} from "@nkzw/fate";
import {view} from "react-fate";
import {describe, expect, it} from "vitest";
import {connectionMetadataOf, getNodeView} from "./useLiveKeepAlive";

const NodeView = view<{__typename: "Post"; id: string}>()({id: true});

const taggedConnection = (metadata: ConnectionMetadata) => {
	const connection: Record<string, unknown> = {items: [], pagination: undefined};
	// Mirror how fate brands a connection result — a non-enumerable symbol field
	// carrying the metadata the pin reads for its stable `listKey`.
	Object.defineProperty(connection, ConnectionTag, {value: metadata, enumerable: false});
	return connection;
};

describe("connectionMetadataOf", () => {
	const metadata = {
		key: "__root__ __fate__ posts __fate__ hot",
		field: "posts",
	} as ConnectionMetadata;

	it("reads the metadata off a fate-branded connection", () => {
		expect(connectionMetadataOf(taggedConnection(metadata))).toBe(metadata);
	});

	it("returns null for a plain array — the transient shape during an in-flight refetch", () => {
		// This is the window the pin must latch *past*: `useRequest` hands back the
		// connection as a bare array (no `ConnectionTag`), which is exactly when the
		// churning `useLiveListView` effect tears its subscription down.
		expect(connectionMetadataOf([])).toBeNull();
	});

	it("returns null for null/undefined/non-object inputs", () => {
		expect(connectionMetadataOf(null)).toBeNull();
		expect(connectionMetadataOf(undefined)).toBeNull();
		expect(connectionMetadataOf("posts")).toBeNull();
	});
});

describe("getNodeView", () => {
	it("unwraps the per-node view from a connection selection", () => {
		expect(getNodeView({items: {node: NodeView}})).toBe(NodeView);
	});

	it("returns the selection itself when it is already a node view", () => {
		expect(getNodeView(NodeView)).toBe(NodeView);
	});
});
