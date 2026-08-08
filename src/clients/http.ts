export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} em ${url}: ${body.slice(0, 500)}`);
    this.name = 'HttpError';
  }

  /** 4xx (exceto 408/429) nao adianta reprocessar. */
  get retryable(): boolean {
    if (this.status === 408 || this.status === 429) return true;
    return this.status >= 500;
  }
}

/** Corpos que usamos de fato: JSON serializado, binario ou multipart. */
export type RequestBody = string | Uint8Array | FormData;

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  body?: RequestBody;
  timeoutMs?: number;
  /** Status codes que NAO devem lancar erro (ex.: 404 esperado). */
  tolerate?: number[];
}

export interface HttpResponse<T> {
  status: number;
  data: T;
}

export async function request<T = unknown>(
  url: string,
  opts: RequestOptions = {},
): Promise<HttpResponse<T>> {
  const { method = 'GET', headers = {}, json, body, timeoutMs = 30_000, tolerate = [] } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const finalHeaders: Record<string, string> = { Accept: 'application/json', ...headers };
  let finalBody: RequestBody | undefined = body;

  if (json !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
    finalBody = JSON.stringify(json);
  }

  try {
    const res = await fetch(url, {
      method,
      headers: finalHeaders,
      body: finalBody,
      signal: controller.signal,
    });

    const raw = await res.text();

    if (!res.ok && !tolerate.includes(res.status)) {
      throw new HttpError(res.status, url, raw);
    }

    let data: unknown = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }

    return { status: res.status, data: data as T };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new HttpError(408, url, `timeout apos ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Busca binario cru (usado para baixar anexos do Chatwoot). */
export async function fetchBinary(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);

  try {
    const res = await fetch(url, { headers: opts.headers, signal: controller.signal });
    if (!res.ok) {
      throw new HttpError(res.status, url, await res.text().catch(() => ''));
    }

    const arr = Buffer.from(await res.arrayBuffer());
    if (opts.maxBytes && arr.byteLength > opts.maxBytes) {
      throw new Error(`Arquivo em ${url} tem ${arr.byteLength} bytes (limite ${opts.maxBytes}).`);
    }
    return { buffer: arr, contentType: res.headers.get('content-type') };
  } finally {
    clearTimeout(timer);
  }
}
