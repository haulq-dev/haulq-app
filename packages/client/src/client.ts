/**
 * The request/error core both front ends share.
 *
 * `apps/web` and `apps/mobile` used to carry their own copy of this: same
 * envelope handling and the same org self-heal, drifting apart one comment
 * at a time. What still differs between them is only *where credentials
 * come from*. Web has a dev-header mode and a Clerk mode; mobile is Clerk in
 * a Capacitor WebView. So that part is injected, and everything else lives here.
 *
 * Deliberately no import of either app's `auth.ts`. This package cannot know
 * whether it runs in a browser tab or a native shell.
 */

import type { ApiError } from '@haulq/contracts';
import type { Session } from './types.ts';

/**
 * A failed request, carrying the API's own explanation.
 *
 * The API guarantees an `explanation` on every error, because guardrail 6
 * applies to failures too. So the UI never has to invent prose from a status
 * code, and this class exists to make that guarantee reach the component
 * that renders it.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly explanation: string;

  constructor(status: number, body: Partial<ApiError>) {
    const explanation = body.explanation ?? 'Something went wrong. Please try again.';
    super(explanation);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body.code ?? 'unknown';
    this.explanation = explanation;
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Sent as-is with the given content type, for the CSV upload and raw document bytes. */
  raw?: { body: BodyInit; contentType: string };
  /** Overrides the stored session for this one call. `null` sends no session at all. */
  session?: Session | null;
}

export interface ApiClientConfig {
  /** `VITE_API_URL`, or web's `/api` proxy fallback. */
  baseUrl: string;
  readSession(): Session | null;
  /** Credentials for one request. Called per request, because a Clerk token rotates. */
  authHeaders(session: Session | null): Promise<Record<string, string>>;
  /**
   * The API answered `unauthenticated` while this session named an org.
   *
   * The API answers "no active membership in this org" the same way it answers
   * "your token is bad". Either way, the org this session points at no
   * longer resolves for whoever is signed in. Left alone, every screen keeps
   * sending the same stale org id forever. Each app drops just the org here,
   * never the whole session, so the next render goes back to the org picker.
   */
  onOrgUnresolved(session: Session): void;
  /** Injected for tests. Defaults to the global. */
  fetch?: typeof fetch;
}

export interface ApiClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  /**
   * Bytes rather than JSON, for a document preview. That can't be a plain
   * `<img src>` because it needs the tenant header and a bearer token.
   * Errors still arrive as the JSON envelope.
   */
  requestBlob(path: string, options?: { session?: Session | null }): Promise<Blob>;
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  const doFetch = config.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const session = options.session !== undefined ? options.session : config.readSession();

    const headers: Record<string, string> = { ...(await config.authHeaders(session)) };
    let body: BodyInit | undefined;

    if (options.raw) {
      headers['Content-Type'] = options.raw.contentType;
      body = options.raw.body;
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const response = await doFetch(`${config.baseUrl}${path}`, {
      method: options.method ?? (body ? 'POST' : 'GET'),
      headers,
      // Spread rather than `body,`: under exactOptionalPropertyTypes an
      // explicit `body: undefined` is not the same as omitting it.
      ...(body !== undefined ? { body } : {}),
    });

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : undefined;

    if (!response.ok) {
      const errorBody = (parsed ?? {}) as Partial<ApiError>;
      if (errorBody.code === 'unauthenticated' && session?.orgId) {
        config.onOrgUnresolved(session);
      }
      throw new ApiRequestError(response.status, errorBody);
    }

    return parsed as T;
  }

  async function requestBlob(path: string, options: { session?: Session | null } = {}): Promise<Blob> {
    const session = options.session !== undefined ? options.session : config.readSession();
    const response = await doFetch(`${config.baseUrl}${path}`, {
      headers: await config.authHeaders(session),
    });

    if (!response.ok) {
      const text = await response.text();
      const parsed = text ? (JSON.parse(text) as Partial<ApiError>) : {};
      throw new ApiRequestError(response.status, parsed);
    }

    return response.blob();
  }

  return { request, requestBlob };
}
