import type { EvseProperties, OpenEvseConfig, OpenEvseStatus } from './types';

export class OpenEvseError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'OpenEvseError';
  }
}

export interface OpenEvseClientOptions {
  host: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Local HTTP client for the OpenEVSE WiFi firmware. No cloud, no login: the charger
 * answers on the LAN, optionally behind HTTP basic auth.
 */
export class OpenEvseClient {
  readonly baseUrl: string;
  private readonly authHeader?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenEvseClientOptions) {
    const host = opts.host.trim().replace(/\/+$/, '');
    this.baseUrl = /^https?:\/\//.test(host) ? host : `http://${host}`;
    if (opts.username) {
      this.authHeader = 'Basic ' + Buffer.from(`${opts.username}:${opts.password ?? ''}`).toString('base64');
    }
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** ws:// URL for the firmware's push event stream. */
  get wsUrl(): string {
    return this.baseUrl.replace(/^http/, 'ws') + '/ws';
  }

  get headers(): Record<string, string> {
    return this.authHeader ? { Authorization: this.authHeader } : {};
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { ...this.headers };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      return await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const msg = (err as Error)?.name === 'AbortError' ? `timed out after ${this.timeoutMs} ms` : String(err);
      throw new OpenEvseError(`${method} ${path}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    if (!res.ok) throw new OpenEvseError(`${method} ${path}: HTTP ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  getStatus(): Promise<OpenEvseStatus> {
    return this.json('GET', '/status');
  }

  getConfig(): Promise<OpenEvseConfig> {
    return this.json('GET', '/config');
  }

  /** Current manual override, or null if none. */
  async getOverride(): Promise<EvseProperties | null> {
    const res = await this.request('GET', '/override');
    if (res.status === 404) return null;
    if (!res.ok) throw new OpenEvseError(`GET /override: HTTP ${res.status}`, res.status);
    const body = (await res.json()) as EvseProperties;
    return body && Object.keys(body).length > 0 ? body : null;
  }

  /**
   * Manual override (priority 1000): beats solar divert, schedules and API claims; only
   * OCPP and safety limits rank higher. auto_release (the default) clears it when the
   * vehicle is unplugged.
   */
  async setOverride(props: EvseProperties): Promise<void> {
    await this.json('POST', '/override', props);
  }

  /** Release the manual override; the charger returns to its automatic (Eco/schedule) state. */
  async clearOverride(): Promise<void> {
    const res = await this.request('DELETE', '/override');
    // 500 "Failed to release" is returned when there is no override to release.
    if (!res.ok && res.status !== 404 && res.status !== 500) {
      throw new OpenEvseError(`DELETE /override: HTTP ${res.status}`, res.status);
    }
  }
}
