import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { OpenEvseClient } from './openevse/client';
import type { OpenEvseStatus } from './openevse/types';
import { mergeEvent } from './openevse/state';
import { AccessoryContext, OpenEvseAccessory } from './accessory';
import { resolveEveUpdateSettings } from './eveUpdates';
import type { EvePowerUpdates } from './eveUpdates';

export const PLUGIN_NAME = 'homebridge-openevse';
export const PLATFORM_NAME = 'OpenEVSE';

interface OpenEvsePlatformConfig extends PlatformConfig {
  host: string;
  username?: string;
  password?: string;
  pollingIntervalSeconds?: number;
  websocket?: boolean;
  chargeNowCurrent?: number;
  temperatureSensor?: boolean;
  faultSensor?: boolean;
  matter?: boolean;
  evePowerUpdates?: EvePowerUpdates;
  minChangeWatts?: number;
  minChangePercent?: number;
  minChangeKwh?: number;
}

/** Events that mean the override/claims changed; re-fetch /override when seen. */
const OVERRIDE_EVENT_KEYS = ['manual_override', 'override_version', 'claims_version'];

export class OpenEvsePlatform implements DynamicPlatformPlugin {
  private readonly cached: PlatformAccessory[] = [];
  private accessory?: OpenEvseAccessory;
  private client?: OpenEvseClient;
  private status: OpenEvseStatus = {};
  private pollTimer?: NodeJS.Timeout;
  private pollInFlight = false;
  private ws?: WebSocket;
  private wsRetryMs = 5_000;
  private wsWatchdog?: NodeJS.Timeout;
  private wsPing?: NodeJS.Timeout;
  private lastOverrideVersion?: unknown;
  private shuttingDown = false;
  // AccessoryInformation is (re)read until the EVSE controller fields are available:
  // /config only includes evse_serial/firmware once the controller has booted.
  private infoComplete = false;
  private infoAttempts = 0;
  private failures = 0;

  constructor(
    public readonly log: Logger,
    private readonly rawConfig: PlatformConfig,
    public readonly api: API,
  ) {
    api.on('didFinishLaunching', () => {
      this.init().catch(err => this.log.error('Plugin failed to initialize:', err));
    });
    api.on('shutdown', () => {
      this.shuttingDown = true;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.closeWs();
    });
  }

  private get config(): OpenEvsePlatformConfig {
    return this.rawConfig as OpenEvsePlatformConfig;
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.push(accessory);
  }

  private async init(): Promise<void> {
    const host = this.config.host?.trim();
    if (!host) {
      this.log.error('No "host" configured for the OpenEVSE charger.');
      return;
    }
    this.client = new OpenEvseClient({ host, username: this.config.username, password: this.config.password });

    // Identify the charger. If it's offline at startup, restore the cached accessory
    // (shown as No Response) and keep retrying in the poll loop.
    let status: OpenEvseStatus | null = null;
    let config = {};
    try {
      [status, config] = await Promise.all([this.client.getStatus(), this.client.getConfig()]);
    } catch (err) {
      this.log.warn(`OpenEVSE at ${host} not reachable yet (${err instanceof Error ? err.message : err}); will keep trying.`);
    }

    const mac = typeof status?.macaddress === 'string' ? status.macaddress : undefined;
    let platformAccessory = this.cached.find(a => (a.context as AccessoryContext).host === host)
      ?? (mac ? this.cached.find(a => (a.context as AccessoryContext).id === mac) : undefined);
    const stale = this.cached.filter(a => a !== platformAccessory);
    if (stale.length) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);

    if (!platformAccessory) {
      if (!status) {
        this.log.error('Cannot create the accessory until the charger has been reached once.');
        this.schedulePoll(30_000, true);
        return;
      }
      const id = mac ?? host;
      const displayName = this.config.name || 'OpenEVSE';
      platformAccessory = new this.api.platformAccessory(displayName, this.api.hap.uuid.generate(`openevse-${id}`));
      (platformAccessory.context as AccessoryContext) = { id, host, displayName };
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
      this.log.info(`Registered OpenEVSE accessory ${displayName} (${id})`);
    } else {
      (platformAccessory.context as AccessoryContext).host = host;
    }

    this.accessory = new OpenEvseAccessory(this.api, this.log, platformAccessory, this.client, {
      matter: this.config.matter ?? false,
      temperatureSensor: this.config.temperatureSensor ?? true,
      faultSensor: this.config.faultSensor ?? true,
      chargeNowCurrent: this.config.chargeNowCurrent,
      eveSettings: resolveEveUpdateSettings(this.config, this.log),
    }, () => this.refreshSoon());

    if (status) {
      this.accessory.setInfo(config, status);
      this.infoComplete = 'firmware' in config;
      this.infoAttempts = 1;
      this.status = status;
    }
    void this.poll();
    if (this.config.websocket ?? true) this.connectWs();
  }

  // ── polling ──────────────────────────────────────────────────────────────────────────

  private intervalMs(): number {
    const base = Math.max(10, this.config.pollingIntervalSeconds ?? 30) * 1000;
    // Without the websocket, poll faster while charging so watts stay fresh.
    const wsUp = this.ws?.readyState === 1;
    return !wsUp && this.accessory?.isCharging ? Math.min(base, 15_000) : base;
  }

  private schedulePoll(ms = this.intervalMs(), initOnly = false): void {
    if (this.shuttingDown) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      if (initOnly && !this.accessory) {
        this.init().catch(err => this.log.error('Init retry failed:', err));
      } else {
        void this.poll();
      }
    }, ms);
  }

  /** Refresh shortly after a command so HomeKit sees the result quickly. */
  private refreshSoon(): void {
    this.schedulePoll(500);
  }

  private async poll(): Promise<void> {
    if (!this.client || !this.accessory || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const status = await this.client.getStatus();
      const needOverride = status.manual_override === 1;
      const override = needOverride ? await this.client.getOverride() : null;
      this.status = status;
      this.lastOverrideVersion = status.override_version;
      this.accessory.update(status, override, true);
      if (!this.infoComplete) {
        const config = await this.client.getConfig();
        this.accessory.setInfo(config, status);
        // Give up after 10 polls if the controller never reports its details.
        this.infoComplete = 'firmware' in config || ++this.infoAttempts >= 10;
      }
      if (this.failures > 0) this.log.info('OpenEVSE reachable again.');
      this.failures = 0;
    } catch (err) {
      this.failures++;
      if (this.failures === 1 || this.failures % 20 === 0) {
        this.log.warn(`Poll failed (${this.failures}x): ${err instanceof Error ? err.message : err}`);
      }
      if (this.failures >= 2) this.accessory.markNoResponse();
    } finally {
      this.pollInFlight = false;
      this.schedulePoll();
    }
  }

  // ── websocket (/ws pushes partial JSON status updates) ─────────────────────────────

  private connectWs(): void {
    if (this.shuttingDown || !this.client) return;
    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) {
      this.log.info('This Node.js has no built-in WebSocket; using polling only.');
      return;
    }
    let ws: WebSocket;
    try {
      // undici's WebSocket accepts headers (needed only if web UI auth is enabled).
      const init = Object.keys(this.client.headers).length ? { headers: this.client.headers } : undefined;
      ws = new (WS as unknown as new (url: string, init?: unknown) => WebSocket)(this.client.wsUrl, init);
    } catch (err) {
      this.log.warn(`WebSocket failed to start: ${err}`);
      this.retryWs();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.log.debug('WebSocket connected');
      this.wsRetryMs = 5_000;
      this.kickWatchdog();
      this.wsPing = setInterval(() => {
        try { ws.send('{"ping":1}'); } catch { /* reconnect via watchdog */ }
      }, 30_000);
    };
    ws.onmessage = (ev: MessageEvent) => {
      this.kickWatchdog();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || 'pong' in msg) return;
      this.status = mergeEvent(this.status, msg);
      const overrideChanged = OVERRIDE_EVENT_KEYS.some(k => k in msg) &&
        (msg.override_version === undefined || msg.override_version !== this.lastOverrideVersion);
      this.accessory?.update(this.status);
      if (overrideChanged) this.refreshSoon();
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      this.log.debug('WebSocket closed');
      this.closeWs();
      this.retryWs();
    };
  }

  private kickWatchdog(): void {
    if (this.wsWatchdog) clearTimeout(this.wsWatchdog);
    // The charger sends status at least every ~30 s and answers pings; 90 s of silence = dead.
    this.wsWatchdog = setTimeout(() => {
      this.log.debug('WebSocket silent for 90 s; reconnecting');
      try { this.ws?.close(); } catch { /* ignore */ }
      this.closeWs();
      this.retryWs();
    }, 90_000);
  }

  private closeWs(): void {
    if (this.wsPing) clearInterval(this.wsPing);
    if (this.wsWatchdog) clearTimeout(this.wsWatchdog);
    this.wsPing = this.wsWatchdog = undefined;
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      this.ws = undefined;
    }
  }

  private retryWs(): void {
    if (this.shuttingDown) return;
    const delay = this.wsRetryMs;
    this.wsRetryMs = Math.min(this.wsRetryMs * 2, 5 * 60_000);
    setTimeout(() => this.connectWs(), delay);
  }
}
