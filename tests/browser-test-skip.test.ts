/** The gate that keeps browser-dependent tests from failing a Chrome-less
 *  sandcastle host, pinned against the real resolver and availability check. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { realHeadless, resolveChromeExecutablePath } from "../src/agent/subagents/headless.ts";
import { browserTestSkipReason } from "./helpers/browser-availability.ts";

describe("browser-dependent test skip predicate", () => {
	it("skips with a CHROME_PATH reason when neither the helper nor Chrome resolves", () => {
		const skip = browserTestSkipReason(() => false, () => null);
		assert.equal(typeof skip, "string");
		assert.match(String(skip), /CHROME_PATH/);
	});

	it("runs when the app's browser helper resolves without system Chrome", () => {
		assert.equal(browserTestSkipReason(() => true, () => null), false);
	});

	it("runs when only a system Chrome resolves", () => {
		assert.equal(browserTestSkipReason(() => false, () => "/usr/bin/google-chrome"), false);
	});

	it("uses the real CHROME_PATH resolver and realHeadless.available()", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-browser-gate-"));
		const chrome = path.join(directory, "chrome");
		fs.writeFileSync(chrome, "", { mode: 0o755 });
		const previous = process.env.CHROME_PATH;
		process.env.CHROME_PATH = chrome;
		try {
			assert.equal(resolveChromeExecutablePath(), chrome);
			assert.equal(realHeadless.available(), true);
			assert.equal(browserTestSkipReason(), false);
		} finally {
			if (previous === undefined) delete process.env.CHROME_PATH;
			else process.env.CHROME_PATH = previous;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
