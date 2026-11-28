/** Admission and manifest checks shared by local install and release packaging. */
import fs from "node:fs";
import path from "node:path";

const NUMERIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENTRY_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const NON_DISTRIBUTABLE = /^(?:\.env(?:\..*)?|auth\.json|.*-credentials\.json.*)$/;

export function directoryRoot(input) {
	const absolute = path.resolve(input);
	const stat = fs.lstatSync(absolute);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error(`Refusing non-directory or symlink root: ${absolute}`);
	return fs.realpathSync(absolute);
}

export function admit(root, filename, kind, optional = false) {
	const relative = path.relative(root, filename);
	if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw Error(`Refusing path outside root: ${filename}`);
	let current = root;
	const parts = relative ? ["", ...relative.split(path.sep)] : [""];
	for (let index = 0; index < parts.length; index++) {
		current = path.join(current, parts[index]);
		const stat = fs.lstatSync(current, { throwIfNoEntry: false });
		if (!stat && optional) return false;
		if (!stat) throw Error(`Missing package path: ${current}`);
		if (stat.isSymbolicLink()) throw Error(`Refusing symlink: ${current}`);
		const directory = index < parts.length - 1 || kind === "directory";
		if (directory ? !stat.isDirectory() : !stat.isFile()) throw Error(`Refusing non-${directory ? "directory" : "file"}: ${current}`);
	}
	return true;
}

export function packageFiles(root, directory) {
	admit(root, directory, "directory");
	return fs.readdirSync(directory).sort().flatMap(name => {
		const filename = path.join(directory, name);
		const stat = fs.lstatSync(filename);
		if (stat.isSymbolicLink()) throw Error(`Refusing package symlink: ${filename}`);
		if (["data", "node_modules", ".git"].includes(name) || NON_DISTRIBUTABLE.test(name)) throw Error(`Refusing non-distributable package entry: ${filename}`);
		if (stat.isDirectory()) return packageFiles(root, filename);
		admit(root, filename, "file");
		return [filename];
	});
}

function requireVersionField(value, key) {
	if (typeof value[key] !== "string" || !NUMERIC_VERSION.test(value[key])) throw Error(`Manifest ${key} must be a numeric x.y.z version`);
}

function requireOptionalString(value, key) {
	if (value[key] !== undefined && typeof value[key] !== "string") throw Error(`Manifest ${key} must be a string`);
}

function requireManifestEntry(value, root, dist, key, extension) {
	if (value[key] === undefined) return;
	const entry = value[key];
	if (typeof entry !== "string" || !ENTRY_NAME.test(entry) || !entry.endsWith(extension)) throw Error(`Manifest ${key} must name a root ${extension} file`);
	admit(root, path.join(dist, entry), "file");
}

/** Validate manifest.json and referenced entry files under dist. */
export function validateBuiltManifest(root, dist) {
	const filename = path.join(dist, "manifest.json");
	admit(root, filename, "file");
	const value = JSON.parse(fs.readFileSync(filename, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid plugin manifest");
	if (typeof value.id !== "string" || !PLUGIN_ID.test(value.id)) throw Error("Invalid plugin manifest id");
	if (value.apiVersion !== 1) throw Error("Expected plugin apiVersion 1");
	if (typeof value.name !== "string" || !value.name.trim()) throw Error("Manifest name is required");
	requireVersionField(value, "version");
	requireVersionField(value, "minAppVersion");
	requireOptionalString(value, "description");
	requireOptionalString(value, "author");
	for (const [key, extension] of [["main", ".js"], ["backend", ".cjs"], ["styles", ".css"]]) requireManifestEntry(value, root, dist, key, extension);
	if (!value.main && !value.backend) throw Error("A plugin needs a main or backend entry");
	if (value.styles && !value.main) throw Error("styles requires a frontend main entry");
	return value;
}

export function validateBuiltPackage(projectRoot, distDirectory = path.join(projectRoot, "dist")) {
	const root = directoryRoot(projectRoot);
	const dist = path.join(root, path.relative(root, path.resolve(distDirectory)));
	admit(root, dist, "directory");
	const manifest = validateBuiltManifest(root, dist);
	const files = packageFiles(root, dist);
	return { root, dist, manifest, files };
}

export function inside(parent, child) {
	const relative = path.relative(parent, child);
	return !relative || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

export function targetDist(root, plugin) {
	admit(root, plugin, "directory", true);
	const dist = path.join(plugin, "dist");
	const exists = admit(root, dist, "directory", true);
	if (fs.lstatSync(path.join(dist, "data"), { throwIfNoEntry: false })) throw Error(`Refusing misplaced dist/data: ${dist}`);
	return exists;
}