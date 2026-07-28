import { requestUrl } from "obsidian";

import type { HttpClientPort, HttpRequest, HttpResponse } from "../parsing/http-client";

export class ObsidianHttpClient implements HttpClientPort {
  async request(request: HttpRequest): Promise<HttpResponse> {
    const body = typeof request.body === "string"
      ? request.body
      : request.body
        ? request.body.buffer.slice(
          request.body.byteOffset,
          request.body.byteOffset + request.body.byteLength
        ) as ArrayBuffer
        : undefined;
    const response = await requestUrl({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body,
      throw: false
    });
    let json: unknown;
    try {
      json = response.json;
    } catch {
      json = undefined;
    }
    return {
      status: response.status,
      headers: Object.fromEntries(
        Object.entries(response.headers).map(([key, value]) => [key.toLocaleLowerCase(), value])
      ),
      bytes: new Uint8Array(response.arrayBuffer),
      text: response.text,
      json
    };
  }
}
