/** Primary-input claim ownership: the registry must release only its own
 *  claim, so a departing editor never strands or steals the dictation target. */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { appendToPrimaryInput, useDictationTarget, usePluginQuestionDictationTarget } from "../components/dictation.tsx";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function fixture() {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React,
		window: dom.window,
		document: dom.document,
		Node: dom.window.Node,
		HTMLElement: dom.window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const root = createRoot(dom.document.getElementById("root")!);
	cleanup = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	};
	return {
		render: async (node: React.ReactNode) => { await act(async () => { root.render(node); }); },
		unmount: async () => { await act(async () => { root.unmount(); }); },
	};
}

test("an older useDictationTarget cleanup cannot clear a newer claim", async () => {
	const f = await fixture();
	const appends: string[] = [];
	const first = (text: string) => { appends.push(`first:${text}`); };
	const second = (text: string) => { appends.push(`second:${text}`); };
	function Harness({ firstClaimed }: { firstClaimed: boolean }) {
		useDictationTarget(first, firstClaimed);
		useDictationTarget(second, true);
		return null;
	}
	await f.render(<Harness firstClaimed />);
	assert.equal(appendToPrimaryInput("live"), true);
	assert.deepEqual(appends, ["second:live"], "the last claim owns the target");
	await f.render(<Harness firstClaimed={false} />);
	assert.equal(appendToPrimaryInput("after release"), true);
	assert.deepEqual(appends, ["second:live", "second:after release"], "the departing older claim leaves the newer one intact");
	await f.unmount();
	assert.equal(appendToPrimaryInput("late"), false, "unmount releases the claim");
});

test("usePluginQuestionDictationTarget releases its claim on unmount", async () => {
	const f = await fixture();
	const appends: string[] = [];
	function Harness() {
		usePluginQuestionDictationTarget((text) => { appends.push(text); }, true, () => {});
		return null;
	}
	await f.render(<Harness />);
	assert.equal(appendToPrimaryInput("spoken"), true);
	assert.deepEqual(appends, ["spoken"]);
	await f.unmount();
	assert.equal(appendToPrimaryInput("late"), false);
	assert.deepEqual(appends, ["spoken"]);
});
