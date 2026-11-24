import { json } from "./http";

export function isLocalDevelopmentUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1") {
    return true;
  }

  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.slice(1).every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

export async function readBoundedJson(
  request: Request,
  maximumBytes: number,
): Promise<unknown | Response> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return json({ error: "Send a JSON request." }, 415);
  }

  const length = request.headers.get("Content-Length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) return json({ error: "The request could not be read." }, 400);
    if (Number(length) > maximumBytes) return json({ error: "The request is too large." }, 413);
  }

  const reader = request.body?.getReader();
  if (!reader) return json({ error: "The request could not be read." }, 400);

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        return json({ error: "The request is too large." }, 413);
      }
      chunks.push(value);
    }
  } catch {
    return json({ error: "The request could not be read." }, 400);
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    ) as unknown;
  } catch {
    return json({ error: "Send valid JSON." }, 400);
  }
}
