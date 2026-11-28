/** Deterministic ZIP32 stored archive. UTF-8 names, fixed DOS timestamp, no platform zip tool. */
import { crc32 } from "node:zlib";

export function createStoredZip(entries) {
	if (entries.length > 65535) throw Error("Too many ZIP entries");
	const local = [], central = [], names = new Set();
	let offset = 0;
	for (const { name, data } of entries) {
		if (name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..") || names.has(name)) throw Error(`Invalid ZIP path: ${name}`);
		names.add(name);
		const filename = Buffer.from(name), bytes = Buffer.from(data);
		if (filename.length > 65535 || bytes.length >= 0xffffffff || offset >= 0xffffffff) throw Error("ZIP32 limit exceeded");
		const checksum = crc32(bytes);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
		header.writeUInt16LE(33, 12);
		header.writeUInt32LE(checksum, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
		local.push(header, filename, bytes);
		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(33, 14);
		record.writeUInt32LE(checksum, 16); record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(filename.length, 28);
		record.writeUInt32LE(0o100644 * 65536, 38); record.writeUInt32LE(offset, 42);
		central.push(record, filename);
		offset += header.length + filename.length + bytes.length;
	}
	const directory = Buffer.concat(central), end = Buffer.alloc(22);
	if (offset + directory.length >= 0xffffffff) throw Error("ZIP32 limit exceeded");
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}