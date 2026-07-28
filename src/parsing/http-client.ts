export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
  text: string;
  json?: unknown;
}

export interface HttpClientPort {
  request(request: HttpRequest): Promise<HttpResponse>;
}
