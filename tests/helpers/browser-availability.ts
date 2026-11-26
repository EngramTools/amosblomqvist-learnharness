/** Gate for tests that acquire a real browser. The app's Electron helper and
 *  system Chrome are both optional on developer/CI hosts, so a missing browser
 *  must skip the test with an actionable reason, not fail the whole suite. */
import { realHeadless, resolveChromeExecutablePath } from "../../src/agent/subagents/headless.ts";

const SKIP_REASON =
	"Skipping browser-dependent test: the app's browser helper did not resolve and no system Chrome was found. " +
	"Set CHROME_PATH to a Chrome/Chromium executable to run it.";

/** `skip` option for node:test: false to run, else the reason to report. */
export function browserTestSkipReason(
	available: () => boolean = () => realHeadless.available(),
	chromePath: () => string | null = () => resolveChromeExecutablePath(),
): string | false {
	// Resolve CHROME_PATH first: checking the helper can download Electron.
	if (chromePath() !== null || available()) return false;
	return SKIP_REASON;
}
