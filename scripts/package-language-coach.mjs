/** Build and zip the language-coach community package for fork releases. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStoredZip } from "./create-stored-zip.mjs";
import { packageFiles, validateBuiltManifest } from "./plugin-dist-validate.mjs";

const PLUGIN_ID = "language-coach";

export function packageLanguageCoach({ root = path.resolve(import.meta.dirname, ".."), outputDirectory = path.join(root, "dist"), runBuild = true } = {}) {
	const project = path.join(root, "plugins", PLUGIN_ID);
	const dist = path.join(project, "dist");
	if (runBuild) {
		const result = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: project, stdio: "inherit" });
		if (result.status !== 0) throw Error(`${PLUGIN_ID}: build failed (${result.signal ?? result.status})`);
	}
	const sourceRoot = fs.realpathSync(project);
	validateBuiltManifest(sourceRoot, dist);
	const files = packageFiles(sourceRoot, dist);
	const prefix = `${PLUGIN_ID}/dist/`;
	const entries = files.map(filename => ({
		name: prefix + path.relative(dist, filename).split(path.sep).join("/"),
		data: fs.readFileSync(filename),
	}));
	const manifest = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8"));
	const archive = path.join(outputDirectory, `${PLUGIN_ID}-${manifest.version}.zip`);
	fs.mkdirSync(outputDirectory, { recursive: true });
	fs.writeFileSync(archive, createStoredZip(entries));
	return { archive, manifest, entries: entries.map(entry => entry.name) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	try {
		const skipBuild = process.argv.includes("--skip-build");
		const outputFlag = process.argv.indexOf("--output");
		const output = outputFlag >= 0 ? process.argv[outputFlag + 1] : path.join(path.resolve(import.meta.dirname, ".."), "dist");
		const result = packageLanguageCoach({ outputDirectory: output, runBuild: !skipBuild });
		console.log(`[language-coach-package] Wrote ${result.archive} (${result.entries.length} files, version ${result.manifest.version})`);
	} catch (error) {
		console.error("[language-coach-package]", error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}