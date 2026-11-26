/** Actual-body bound, independent of absent or untrustworthy Content-Length. */
export class FormBodyLimitError extends Error {}

/** RFC 2046 allows an epilogue after the closing delimiter. undici refuses the
 *  whole body when one is present, and Next's body clone truncation can leave
 *  one behind, so cut the body at the closing delimiter before parsing. */
function trimMultipartEpilogue(body: Uint8Array<ArrayBuffer>, contentType: string | null): Uint8Array<ArrayBuffer> {
	const boundary = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
	const delimiter = boundary?.[1] ?? boundary?.[2];
	if (!delimiter?.trim()) return body;
	const closing = Buffer.from(`--${delimiter.trim()}--`);
	const index = Buffer.from(body.buffer, body.byteOffset, body.byteLength).lastIndexOf(closing);
	if (index < 0) return body;
	const end = index + closing.length + (body[index + closing.length] === 13 && body[index + closing.length + 1] === 10 ? 2 : 0);
	return body.subarray(0, end);
}

/** Buffer before multipart parsing: malformed/truncated uploads never yield a
 * partial form. Optional cancellation interrupts even a blocked reader.read(). */
export async function readBoundedFormData(request: Request, maxBytes: number, signal?: AbortSignal): Promise<FormData> {
	signal?.throwIfAborted();
	if (Number(request.headers.get("content-length")) > maxBytes) {
		void request.body?.cancel().catch(() => undefined);
		throw new FormBodyLimitError();
	}
	const reader = request.body?.getReader();
	if (!reader) throw new SyntaxError("Missing import body");
	const cancel = () => { void reader.cancel().catch(() => undefined); };
	signal?.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		signal?.throwIfAborted();
		for (;;) {
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new FormBodyLimitError();
			chunks.push(value);
		}
		const body = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const contentType = request.headers.get("content-type") ?? "";
		const form = await new Response(trimMultipartEpilogue(body, contentType), { headers: { "Content-Type": contentType } }).formData();
		signal?.throwIfAborted();
		return form;
	} finally {
		signal?.removeEventListener("abort", cancel);
		// Do not wait for a tee's other consumer to finish before refusing an upload.
		cancel();
		reader.releaseLock();
	}
}
