import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";

export type StubRequest = {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

export type StubServer = {
  url: string;
  host: string;
  requests: StubRequest[];
  close: () => Promise<void>;
};

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function stubSpeechServer(respond: (request: StubRequest, response: ServerResponse) => void): Promise<StubServer> {
  const requests: StubRequest[] = [];
  const server = createServer(async (request, response) => {
    const captured = {
      method: request.method,
      path: request.url,
      headers: request.headers,
      body: await readBody(request),
    };
    requests.push(captured);
    respond(captured, response);
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const host = `http://127.0.0.1:${address.port}`;
  return {
    url: `${host}/speech/recognition/conversation/cognitiveservices/v1`,
    host,
    requests,
    close: () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(error => error ? closed.reject(error) : closed.resolve());
      return closed.promise;
    },
  };
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}