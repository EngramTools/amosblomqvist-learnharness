import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(source: string): Record<string, unknown> };
import { packageLanguageCoach } from "../scripts/package-language-coach.mjs";
import { validateBuiltManifest, validateBuiltPackage } from "../scripts/plugin-dist-validate.mjs";
import { setupPlugins } from "../scripts/setup-plugins.mjs";
import { parsePluginManifest } from "../src/core/plugins.ts";

const root = path.resolve(import.meta.dirname, "..");
const STOCK_APP = "0.7.0";

/** Independent ZIP reader, not the production encoder. */
function unzip(bytes: Buffer) {
	const result = new Map<string, Buffer>();
	let offset = 0;
	while (bytes.readUInt32LE(offset) === 0x04034b50) {
		const size = bytes.readUInt32LE(offset + 18);
		const nameLength = bytes.readUInt16LE(offset + 26);
		const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
		result.set(name, bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size));
		offset += 30 + nameLength + size;
	}
	return result;
}

function extractZip(archive: string, pluginsDirectory: string) {
	for (const [name, data] of unzip(fs.readFileSync(archive))) {
		const target = path.join(pluginsDirectory, ...name.split("/"));
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, data);
	}
}

test("language-coach release package matches local install validation and stock app compatibility", () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-language-coach-package-"));
	const output = path.join(scratch, "out");
	const pluginsDirectory = path.join(scratch, "plugins");
	try {
		setupPlugins(root);
		const packaged = packageLanguageCoach({ root, outputDirectory: output, runBuild: true });
		assert.match(path.basename(packaged.archive), /^language-coach-\d+\.\d+\.\d+\.zip$/);
		assert.equal(path.basename(packaged.archive), `language-coach-${packaged.manifest.version}.zip`);
		fs.mkdirSync(pluginsDirectory, { recursive: true });
		extractZip(packaged.archive, pluginsDirectory);
		const pluginRoot = path.join(pluginsDirectory, "language-coach");
		const installedDist = path.join(pluginRoot, "dist");
		assert.equal(fs.existsSync(path.join(installedDist, "manifest.json")), true);
		const local = validateBuiltPackage(pluginRoot);
		assert.equal(local.manifest.id, "language-coach");
		const host = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(installedDist, "manifest.json"), "utf8")), "language-coach", STOCK_APP);
		assert.doesNotThrow(() => validateBuiltManifest(local.root, local.dist));
		assert.equal(host.id, "language-coach");
		const backend = fs.readFileSync(path.join(installedDist, "backend.cjs"), "utf8");
		const frontend = fs.readFileSync(path.join(installedDist, "main.js"), "utf8");
		for (const bundle of [backend, frontend]) {
			assert.doesNotMatch(bundle, /node_modules\//, "bundle must not reference node_modules");
			assert.doesNotMatch(bundle, /["'](?:pinyin-pro|cmudict)(?:\/|["'])/i, "data libraries must be bundled");
		}
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
});

test("fork language-coach workflow does not share upstream desktop release triggers", () => {
	type Workflow = { on?: Record<string, unknown> };
	const fork = yaml.load(fs.readFileSync(path.join(root, ".github", "workflows", "language-coach-release.yml"), "utf8")) as Workflow;
	const release = yaml.load(fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8")) as Workflow;
	const notify = yaml.load(fs.readFileSync(path.join(root, ".github", "workflows", "notify-website.yml"), "utf8")) as { on?: { release?: unknown } };
	const forkTags = fork.on?.push as { tags?: string[] } | undefined;
	assert.deepEqual(forkTags?.tags, ["language-coach-v*"]);
	const upstreamTags = (release.on?.push as { tags?: string[] } | undefined)?.tags;
	assert.deepEqual(upstreamTags, ["v*"]);
	assert.equal((forkTags?.tags ?? []).some(tag => tag === "v*" || tag === "v**"), false);
	assert.equal(notify.on?.release != null, true);
	assert.match(fs.readFileSync(path.join(root, ".github", "workflows", "language-coach-release.yml"), "utf8"), /repository\s*!=\s*['"]amosblomqvist\/learnharness['"]/);
});

test("fork workflow packages through the shared script", () => {
	const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "language-coach-release.yml"), "utf8");
	assert.match(workflow, /node scripts\/package-language-coach\.mjs/);
});