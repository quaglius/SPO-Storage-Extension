import type { ApiError } from '@spostorage/shared';

export class ApiClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
  }
}

type ApiListener = (error: ApiClientError) => void;

const listeners = new Set<ApiListener>();

export function onApiError(listener: ApiListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyError(error: ApiClientError): void {
  for (const listener of listeners) {
    listener(error);
  }
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit & { params?: Record<string, string | number | boolean | undefined> },
): Promise<T> {
  const { params, ...fetchInit } = init ?? {};
  let url = path.startsWith('/api') ? path : `/api${path}`;

  if (params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        search.set(key, String(value));
      }
    }
    const qs = search.toString();
    if (qs) url += `?${qs}`;
  }

  const controller = new AbortController();
  const timeoutMs = 45_000;
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  if (fetchInit.signal) {
    const outer = fetchInit.signal;
    if (outer.aborted) {
      controller.abort();
    } else {
      outer.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(fetchInit.body ? { 'Content-Type': 'application/json' } : {}),
        ...fetchInit.headers,
      },
      ...fetchInit,
      signal: controller.signal,
    });
  } catch (err) {
    window.clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === 'AbortError') {
      const error = new ApiClientError(
        'TIMEOUT',
        'The request took too long and was cancelled to avoid overloading the server.',
      );
      notifyError(error);
      throw error;
    }
    throw err;
  }
  window.clearTimeout(timeoutId);

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    const error = new ApiClientError(
      'AUTH_REQUIRED',
      'Your session is not authenticated or has expired. Reload the page and sign in again.',
    );
    notifyError(error);
    throw error;
  }

  if (!response.ok) {
    let message = response.statusText;
    let code = 'HTTP_ERROR';
    try {
      const body = (await parseJson<ApiError>(response.clone())) as ApiError;
      if (body.error) {
        message = body.error.message;
        code = body.error.code;
      }
    } catch {
      // ignore parse errors
    }
    const error = new ApiClientError(code, message);
    notifyError(error);
    throw error;
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return parseJson<T>(response);
}

export function apiGet<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  return apiFetch<T>(path, { params });
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'PUT',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export function apiDelete<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: 'DELETE' });
}

export async function apiUpload<T>(
  path: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<T> {
  const url = path.startsWith('/api') ? path : `/api${path}`;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Accept', 'application/json');

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(xhr.responseText ? (JSON.parse(xhr.responseText) as T) : ({} as T));
        } catch {
          reject(new ApiClientError('PARSE_ERROR', 'Invalid response from server'));
        }
        return;
      }

      let message = xhr.statusText;
      let code = 'HTTP_ERROR';
      try {
        const body = JSON.parse(xhr.responseText) as ApiError;
        if (body.error) {
          message = body.error.message;
          code = body.error.code;
        }
      } catch {
        // ignore
      }
      const error = new ApiClientError(code, message);
      notifyError(error);
      reject(error);
    };

    xhr.onerror = () => {
      const error = new ApiClientError('NETWORK_ERROR', 'Network error while uploading the file');
      notifyError(error);
      reject(error);
    };

    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  });
}

export function downloadUrl(path: string, filename: string): void {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
}
