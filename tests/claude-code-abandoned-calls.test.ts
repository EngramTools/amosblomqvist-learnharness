/**
 * Abandoned Claude CLI tool calls (src/agent/claude-code/abandoned-calls.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import {
	ABANDONED_CALL_MESSAGE,
	abandonedToolResult,
	clearResumedAbandonedIds,
	discardAbandonedPendingCalls,
} from "../src/agent/claude-code/abandoned-calls.ts";
import { createToolBridge, type PendingToolCall } from "../src/agent/claude-code/tool-bridge.ts";

const READ_TOOL = { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };

test("abandonedToolResult is an error tool result with the abandoned message", () => {
	const call: PendingToolCall = { id: "toolu_abandoned", name: "read", arguments: { path: "a" } };
	assert.equal(abandonedToolResult(call).isError, true);
	assert.deepEqual(abandonedToolResult(call).content, [{ type: "text", text: ABANDONED_CALL_MESSAGE }]);
	assert.equal(abandonedToolResult(call).toolCallId, call.id);
});

test("clearResumedAbandonedIds drops ids the retried message streams again", () => {
	const abandoned = new Set(["toolu_a", "toolu_b"]);
	clearResumedAbandonedIds(abandoned, [{ id: "toolu_a" }]);
	assert.deepEqual([...abandoned], ["toolu_b"]);
});

test("discardAbandonedPendingCalls resolves abandoned pending calls", async (t) => {
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
	const bridge = await createToolBridge([READ_TOOL]);
	t.after(() => bridge.close());
	const config = JSON.parse(bridge.mcpConfig) as { mcpServers: { learnharness: { url: string; headers: { Authorization: string } } } };
	const server = config.mcpServers.learnharness;
	const client = new Client({ name: "test", version: "0" });
	await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
	t.after(() => client.close());
	const abandoned = new Set(["toolu_abandoned"]);
	const request = client.callTool({
		name: "read",
		arguments: { path: "a" },
		_meta: { "claudecode/toolUseId": "toolu_abandoned" },
	});
	const [pending] = await bridge.waitForToolCalls(1);
	discardAbandonedPendingCalls(bridge, abandoned);
	assert.deepEqual(bridge.getPendingToolCalls(), []);
	const result = await request;
	assert.equal(result.isError, true);
});