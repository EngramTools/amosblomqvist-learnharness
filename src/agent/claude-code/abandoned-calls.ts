import type { ToolResultMessage } from "@earendil-works/pi-ai";

import type { PendingToolCall, ToolBridge } from "./tool-bridge.ts";

export const ABANDONED_CALL_MESSAGE = "claude CLI abandoned this tool call";

export function clearResumedAbandonedIds(abandoned: Set<string>, calls: Iterable<{ id: string }>): void {
	for (const call of calls) abandoned.delete(call.id);
}

export function abandonedToolResult(call: PendingToolCall): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: ABANDONED_CALL_MESSAGE }],
		isError: true,
		timestamp: Date.now(),
	};
}

/** Answer bridge requests from an abandoned attempt so a retried call with the same id can run. */
export function discardAbandonedPendingCalls(bridge: ToolBridge, abandoned: Set<string>): void {
	for (const call of bridge.getPendingToolCalls()) {
		if (!abandoned.has(call.id)) continue;
		bridge.resolveToolCall(call, abandonedToolResult(call));
		bridge.forgetToolUseId(call.id);
	}
}