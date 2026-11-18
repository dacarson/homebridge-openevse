import type { API, Logger, PlatformAccessory, Service } from 'homebridge';
import type { Characteristic } from 'homebridge';
import type { OpenEvseClient } from './openevse/client';
import type { EvseProperties, OpenEvseConfig, OpenEvseStatus } from './openevse/types';
import { ChargerView, actionForOn, deviceInfo, viewFromStatus } from './openevse/state';
import { buildEveCharacteristics } from './eveCharacteristics';
import { MatterEnergyBridge, EnergyReadings } from './matterEnergy';
import {
  DEFAULT_EVE_UPDATE_SETTINGS,
  EveCharacteristicUpdater,
  EveUpdateGroup,
  EveUpdateSettings,
  anyChange,
  kwhThreshold,
  wattsThreshold,
} from './eveUpdates';
import { EVE_HISTORY_INTERVAL_MS, EveEnergyHistory, fillEnergyHistoryTemperatures } from './eveHistory';
import fakegato = require('fakegato-history');

export interface AccessoryContext {
  id: string;           // stable id: MAC address if known, else host
  host: string;
  displayName: string;
}

export interface AccessoryOptions {
  matter: boolean;
  temperatureSensor: boolean;
  chargeNowCurrent?: number;
  eveSettings: EveUpdateSettings;
}

const TEMP_SUBTYPE = 'evse-temperature';
// Earlier builds added a ContactSensor with this subtype for faults; it's removed from
// cached accessories on startup. Faults are reported via StatusFault on the temperature sensor.
const LEGACY_FAULT_SUBTYPE = 'evse-fault';
const EVE_HISTORY_SERVICE_UUID = 'E863F007-079E-48FF-8F27-9C2605A29F52';
const EVE_HISTORY_ENTRIES_UUID = 'E863F117-079E-48FF-8F27-9C2605A29F52'; // S2R2

// fakegato-history internals used to store and read back temperature per entry.
interface FakeGatoInternals {
  _addEntry(entry: { time: number; power: number; temp?: number }): void;
  getCurrentS2R2(callback: (err: unknown, value?: string) => void): void;
  history: Array<{ temp?: number } | undefined>;
  memorySize: number;
}

export class OpenEvseAccessory {
  readonly id: string;
  private readonly outlet: Service;
  private readonly tempService?: Service;

  private readonly charOn: Characteristic;
  private readonly charOutletInUse: Characteristic;

  private readonly eveUpdates: EveUpdateGroup;
  private readonly eveCurrentConsumption: EveCharacteristicUpdater;
  private readonly eveTotalConsumption: EveCharacteristicUpdater;
  private readonly eveVoltage: EveCharacteristicUpdater;
  private readonly eveElectricCurrent: EveCharacteristicUpdater;

  private readonly history: InstanceType<ReturnType<typeof fakegato>>;
  private readonly energyHistory = new EveEnergyHistory();
  private historyTimer: NodeJS.Timeout | null = null;
  private lastTemperatureC: number | null = null;

  private matter: MatterEnergyBridge | null = null;
  // WebSocket events can arrive every second or two; Matter gets at most one update per
  // MATTER_MIN_INTERVAL_MS (plus immediately when charging starts/stops), matching the
  // cadence matterEnergy.ts was designed for.
  private lastMatterMs = 0;
  private matterRegisterStarted = false;
  private lastMatterCharging = false;
  private static readonly MATTER_MIN_INTERVAL_MS = 15_000;

  private status: OpenEvseStatus | null = null;
  private override: EvseProperties | null = null;
  private view: ChargerView | null = null;
  private lastFaultName: string | null = null;
  private lastMode: string | null = null;
  private commandInFlight = false;
  private lastInfoLog = '';

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly accessory: PlatformAccessory,
    private readonly client: OpenEvseClient,
    private readonly opts: AccessoryOptions,
    private readonly requestRefresh: () => void,
  ) {
    const ctx = accessory.context as AccessoryContext;
    this.id = ctx.id;
    const { Service: S, Characteristic: C } = api.hap;
    const eve = buildEveCharacteristics(api.hap);

    this.outlet = accessory.getService(S.Outlet) ?? accessory.addService(S.Outlet, ctx.displayName);
    this.charOn = this.outlet.getCharacteristic(C.On);
    this.charOn.onSet(value => this.setOn(value as boolean));
    this.charOutletInUse = this.outlet.getCharacteristic(C.OutletInUse);
    const cc = this.getOrAdd(eve.CurrentConsumption());
    const tc = this.getOrAdd(eve.TotalConsumption());
    const v = this.getOrAdd(eve.Voltage());
    const ec = this.getOrAdd(eve.ElectricCurrent());

    const eveSettings = opts.eveSettings ?? DEFAULT_EVE_UPDATE_SETTINGS;
    this.eveUpdates = new EveUpdateGroup(eveSettings, log);
    this.eveCurrentConsumption = this.eveUpdates.add(cc, 'watts', wattsThreshold(eveSettings));
    this.eveTotalConsumption = this.eveUpdates.add(tc, 'kWh', kwhThreshold(eveSettings));
    this.eveVoltage = this.eveUpdates.add(v, 'volts', anyChange);
    this.eveElectricCurrent = this.eveUpdates.add(ec, 'amps', anyChange);

    // Optional sensors; removed from the cached accessory when turned off.
    const existingTemp = accessory.getServiceById(S.TemperatureSensor, TEMP_SUBTYPE);
    if (opts.temperatureSensor) {
      this.tempService = existingTemp ??
        accessory.addService(S.TemperatureSensor, `${ctx.displayName} Temperature`, TEMP_SUBTYPE);
      this.tempService.getCharacteristic(C.CurrentTemperature).setProps({ minValue: -40, maxValue: 125 });
    } else if (existingTemp) {
      accessory.removeService(existingTemp);
    }
    const legacyFault = accessory.getServiceById(S.ContactSensor, LEGACY_FAULT_SUBTYPE);
    if (legacyFault) accessory.removeService(legacyFault);

    const FakeGatoHistoryService = fakegato(api);
    this.history = new FakeGatoHistoryService('energy', accessory, {
      size: 4032,
      storage: 'fs',
      disableTimer: true,
    });
    if (this.tempService) this.fillHistoryTemperatures();
    this.energyHistory.sample(0, Date.now());
    this.historyTimer = setInterval(() => this.recordHistory(), EVE_HISTORY_INTERVAL_MS);
    this.historyTimer.unref?.();

    if (opts.matter) {
      const bridge = new MatterEnergyBridge(api, log);
      if (bridge.isSupported()) {
        this.matter = bridge;
        // Registered from setInfo(), once the charger's serial and model are known.
      } else {
        log.info('[matter] "matter" is enabled, but the Matter API is unavailable. It needs Homebridge 2.3.0 or later with Matter enabled on this plugin\'s child bridge. Continuing with HomeKit/Eve only.');
      }
    }
  }

  private getOrAdd(instance: Characteristic): Characteristic {
    const existing = this.outlet.characteristics.find(c => c.UUID === instance.UUID);
    return existing ?? (this.outlet.addCharacteristic(instance) as unknown as Characteristic);
  }

  setInfo(config: OpenEvseConfig, status: OpenEvseStatus): void {
    const { Service: S, Characteristic: C } = this.api.hap;
    const info = this.accessory.getService(S.AccessoryInformation)!;
    const d = deviceInfo(config, status, this.id);
    if (this.matter && !this.matterRegisterStarted) {
      this.matterRegisterStarted = true;
      const ctx = this.accessory.context as AccessoryContext;
      this.matter.register(this.id, ctx.displayName, this.readings(this.view),
        { serialNumber: d.serialNumber, model: d.model }).catch(() => {});
    }
    info.setCharacteristic(C.Manufacturer, 'OpenEVSE');
    info.setCharacteristic(C.Model, d.model);
    info.setCharacteristic(C.SerialNumber, d.serialNumber);
    if (d.firmwareRevision) info.setCharacteristic(C.FirmwareRevision, d.firmwareRevision);
    const line =
      `[${this.id}] WiFi firmware ${d.wifiFirmware ?? 'unknown'}` +
      (d.firmwareRevision ? '' : ' (not a release version; FirmwareRevision left unchanged)') +
      `, EVSE controller firmware ${d.controllerFirmware ?? 'unknown'}` +
      `, serial ${d.serialNumber} (from ${d.serialSource})`;
    if (line !== this.lastInfoLog) {
      this.log.info(line);
      this.lastInfoLog = line;
    }
  }

  private readings(view: ChargerView | null): EnergyReadings {
    return {
      voltageV: view?.voltageV ?? 240,
      currentA: view?.currentA ?? 0,
      powerW: view?.powerW ?? 0,
      energyWh: (view?.totalKwh ?? 0) * 1000,
    };
  }

  /** Apply a fresh status (from poll or websocket). `override` undefined = unchanged. */
  update(status: OpenEvseStatus, override?: EvseProperties | null): void {
    this.status = status;
    if (override !== undefined) this.override = override;
    // The status flag is authoritative for whether an override exists at all.
    if (status.manual_override === 0) this.override = null;
    const view = viewFromStatus(status, this.override);
    this.view = view;
    const { Characteristic: C } = this.api.hap;

    this.charOn.updateValue(view.on);
    this.charOutletInUse.updateValue(view.pluggedIn);
    this.eveCurrentConsumption.update(view.powerW);
    this.eveTotalConsumption.update(view.totalKwh);
    this.eveVoltage.update(view.voltageV);
    this.eveElectricCurrent.update(view.currentA);
    this.eveUpdates.logStatsIfDue();

    if (this.tempService) {
      if (view.temperatureC !== null) {
        this.tempService.updateCharacteristic(C.CurrentTemperature, view.temperatureC);
        this.lastTemperatureC = view.temperatureC;
      }
      // EVSE errors (GFCI, no ground, stuck relay, over-temperature, ...) -> Status Fault
      this.tempService.updateCharacteristic(C.StatusFault, view.fault ? 1 : 0);
    }
    if (view.faultName !== this.lastFaultName) {
      if (view.faultName) this.log.warn(`[${this.id}] EVSE fault: ${view.faultName}`);
      else if (this.lastFaultName) this.log.info(`[${this.id}] EVSE fault cleared`);
      this.lastFaultName = view.faultName;
    }
    if (view.mode !== this.lastMode) {
      this.log.info(`[${this.id}] Mode: ${view.mode}`);
      this.lastMode = view.mode;
    }

    if (this.matter) {
      const now = Date.now();
      if (view.charging !== this.lastMatterCharging || now - this.lastMatterMs >= OpenEvseAccessory.MATTER_MIN_INTERVAL_MS) {
        this.lastMatterMs = now;
        this.lastMatterCharging = view.charging;
        this.matter.update(this.readings(view)).catch(() => {});
      }
    }
    this.energyHistory.sample(view.powerW, Date.now());
  }

  /** Every 10 minutes: add the window's average power (split if > 3276.7 W) to Eve history. */
  private recordHistory(): void {
    const now = Date.now();
    const powers = this.energyHistory.flush(now);
    const temp = this.tempService && this.lastTemperatureC !== null ? this.lastTemperatureC : undefined;
    const internals = this.history as unknown as FakeGatoInternals;
    powers.forEach((power, i) => {
      // Split entries get distinct, increasing timestamps ending at `now`.
      const time = Math.round(now / 1000) - (powers.length - 1 - i);
      if (temp !== undefined) {
        // fakegato's addEntry drops everything but power for 'energy'; _addEntry keeps
        // temp in the stored (and persisted) entry so it can be sent to Eve.
        internals._addEntry({ time, power, temp });
      } else {
        this.history.addEntry({ time, power });
      }
    });
    if (powers.length > 1) {
      this.log.debug(`[${this.id}] Eve history: ${powers.length} entries of ${powers[0]} W for one 10-minute window`);
    }
  }

  stop(): void {
    if (this.historyTimer) clearInterval(this.historyTimer);
    this.historyTimer = null;
  }

  /**
   * fakegato writes 0 for the temperature field of Eve energy history records, so with the
   * temperature sensor present Eve graphs a flat 0 °C. Wrap the history-read handler and
   * fill in the temperature stored with each entry (entries recorded before this was
   * added have none and stay at 0).
   */
  private fillHistoryTemperatures(): void {
    const internals = this.history as unknown as FakeGatoInternals;
    const char = this.accessory.services
      .find(s => s.UUID === EVE_HISTORY_SERVICE_UUID)
      ?.characteristics.find(c => c.UUID === EVE_HISTORY_ENTRIES_UUID);
    if (!char) {
      this.log.debug(`[${this.id}] Eve history characteristic not found; history temperatures not filled`);
      return;
    }
    const tempForEntry = (entry: number) => internals.history[entry % internals.memorySize]?.temp;
    char.removeAllListeners('get');
    char.on('get', callback => {
      internals.getCurrentS2R2((err, value) => {
        if (err || typeof value !== 'string') return callback(err as Error | null, value);
        try {
          callback(null, fillEnergyHistoryTemperatures(value, tempForEntry));
        } catch {
          callback(null, value);
        }
      });
    });
  }

  markNoResponse(): void {
    this.energyHistory.sample(0, Date.now());
    this.charOn.updateValue(new Error('No Response') as unknown as boolean);
  }

  get isCharging(): boolean {
    return this.view?.charging ?? false;
  }

  private setOn(turnOn: boolean): void {
    if (this.commandInFlight) {
      this.log.warn(`[${this.id}] Command already in flight; ignoring.`);
      this.revert();
      return;
    }
    const action = actionForOn(turnOn, this.override, this.view?.charging ?? false, this.opts.chargeNowCurrent);
    if (action.kind === 'none') {
      this.revert();
      return;
    }
    this.commandInFlight = true;
    const run = action.kind === 'override'
      ? this.client.setOverride(action.props).then(() => {
        this.override = action.props;
        this.log.info(`[${this.id}] Manual override: ${action.props.state}` +
          (action.props.charge_current ? ` at ${action.props.charge_current} A` : ''));
      })
      : this.client.clearOverride().then(() => {
        this.override = null;
        this.log.info(`[${this.id}] Manual override released; back to automatic`);
      });
    run
      .catch(err => {
        this.log.error(`[${this.id}] ${turnOn ? 'Start' : 'Stop'} failed: ${err instanceof Error ? err.message : err}`);
        this.revert();
      })
      .finally(() => {
        this.commandInFlight = false;
        this.requestRefresh();
      });
  }

  private revert(): void {
    const on = this.view?.on ?? false;
    setImmediate(() => this.charOn.updateValue(on));
  }
}
