/** Copy a built community package into an explicit plugins directory.
 * Portable: Node built-ins only. Run the project's build before this helper.
 * The host, not this helper, decides app compatibility and plugin enablement. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	admit, directoryRoot, inside, packageFiles, targetDist, validateBuiltManifest,
} from "./plugin-dist-validate.mjs";

export function installPluginLocal({ project = process.cwd(), pluginsDirectory }) {
	if (typeof pluginsDirectory !== "string" || !pluginsDirectory.trim()) throw Error("An explicit plugins directory is required");
	const sourceRoot = directoryRoot(project), destinationRoot = directoryRoot(pluginsDirectory);
	const source = path.join(sourceRoot, "dist");
	const entries = packageFiles(sourceRoot, source);
	const pkg = validateBuiltManifest(sourceRoot, source);
	const plugin = path.join(destinationRoot, pkg.id), destination = path.join(plugin, "dist");
	if (source === destination) return { id: pkg.id, directory: destination, copied: false };
	if (inside(source, destination) || inside(destination, source)) throw Error("Refusing overlapping source and destination dist directories");
	targetDist(destinationRoot, plugin);
	fs.mkdirSync(plugin, { recursive: true });
	admit(destinationRoot, plugin, "directory");
	const stage = fs.mkdtempSync(path.join(plugin, ".install-"));
	const next = path.join(stage, "next"), previous = path.join(stage, "previous");
	let movedOld = false, installed = false, keepBackup = false;
	try {
		fs.mkdirSync(next);
		for (const filename of entries) {
			admit(sourceRoot, filename, "file");
			const output = path.join(next, path.relative(source, filename));
			fs.mkdirSync(path.dirname(output), { recursive: true });
			fs.copyFileSync(filename, output);
		}
		validateBuiltManifest(stage, next);
		if (targetDist(destinationRoot, plugin)) { fs.renameSync(destination, previous); movedOld = true; }
		fs.renameSync(next, destination);
		installed = true;
		return { id: pkg.id, directory: destination, copied: true };
	} catch (error) {
		if (movedOld && !installed) {
			try { fs.renameSync(previous, destination); }
			catch (rollbackError) {
				keepBackup = true;
				throw new Error(`Installation failed and rollback failed. Previous dist preserved at ${previous}: ${rollbackError.message}`, { cause: error });
			}
		}
		throw error;
	} finally {
		if (!keepBackup) fs.rmSync(stage, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		if (process.argv.length !== 3 || !process.argv[2].trim()) throw Error('Usage: node scripts/install-plugin-local.mjs "<plugins-directory>" (run after building)');
		const result = installPluginLocal({ pluginsDirectory: process.argv[2] });
		console.log(`[plugin-install] ${result.copied ? "Installed" : "Already built in place"}: ${result.directory}`);
		console.log("Refresh Community plugins and enable new plugins. Restart LearnHarness to load changes to already-loaded code.");
	} catch (error) { console.error("[plugin-install]", error.message); process.exitCode = 1; }
}