import type { API, Logger, PlatformAccessory, Service } from 'homebridge';
import type { Characteristic } from 'hap-nodejs';
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
import fakegato = require('fakegato-history');

export interface AccessoryContext {
  id: string;           // stable id: MAC address if known, else host
  host: string;
  displayName: string;
}

export interface AccessoryOptions {
  matter: boolean;
  temperatureSensor: boolean;
  faultSensor: boolean;
  chargeNowCurrent?: number;
  eveSettings: EveUpdateSettings;
}

const TEMP_SUBTYPE = 'evse-temperature';
const FAULT_SUBTYPE = 'evse-fault';

export class OpenEvseAccessory {
  readonly id: string;
  private readonly outlet: Service;
  private readonly tempService?: Service;
  private readonly faultService?: Service;

  private readonly charOn: Characteristic;
  private readonly charOutletInUse: Characteristic;

  private readonly eveUpdates: EveUpdateGroup;
  private readonly eveCurrentConsumption: EveCharacteristicUpdater;
  private readonly eveTotalConsumption: EveCharacteristicUpdater;
  private readonly eveVoltage: EveCharacteristicUpdater;
  private readonly eveElectricCurrent: EveCharacteristicUpdater;

  private readonly history: InstanceType<ReturnType<typeof fakegato>>;
  private lastIdleHistoryMs = 0;
  private lastHistoryPower = 0;
  private static readonly IDLE_HISTORY_INTERVAL_MS = 10 * 60 * 1000;

  private matter: MatterEnergyBridge | null = null;
  // WebSocket events can arrive every second or two; Matter gets at most one update per
  // MATTER_MIN_INTERVAL_MS (plus immediately when charging starts/stops), matching the
  // cadence matterEnergy.ts was designed for.
  private lastMatterMs = 0;
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
    const existingFault = accessory.getServiceById(S.ContactSensor, FAULT_SUBTYPE);
    if (opts.faultSensor) {
      this.faultService = existingFault ??
        accessory.addService(S.ContactSensor, `${ctx.displayName} Fault`, FAULT_SUBTYPE);
    } else if (existingFault) {
      accessory.removeService(existingFault);
    }

    const FakeGatoHistoryService = fakegato(api);
    this.history = new FakeGatoHistoryService('energy', accessory, {
      size: 4032,
      storage: 'fs',
      disableTimer: true,
    });

    if (opts.matter) {
      const bridge = new MatterEnergyBridge(api, log);
      if (bridge.isSupported()) {
        this.matter = bridge;
        bridge.register(this.id, ctx.displayName, this.readings(null)).catch(() => {});
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
  update(status: OpenEvseStatus, override?: EvseProperties | null, recordHistory = false): void {
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

    if (this.tempService && view.temperatureC !== null) {
      this.tempService.updateCharacteristic(C.CurrentTemperature, view.temperatureC);
      this.tempService.updateCharacteristic(C.StatusFault, view.fault ? 1 : 0);
    }
    if (this.faultService) {
      this.faultService.updateCharacteristic(C.ContactSensorState, view.fault ? 1 : 0);
      this.faultService.updateCharacteristic(C.StatusFault, view.fault ? 1 : 0);
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
    if (recordHistory || (this.lastHistoryPower > 0 && view.powerW === 0)) this.recordHistory(view);
  }

  private recordHistory(view: ChargerView): void {
    const now = Date.now();
    const endedCharging = this.lastHistoryPower > 0 && view.powerW === 0;
    if (view.powerW > 0 || endedCharging || now - this.lastIdleHistoryMs >= OpenEvseAccessory.IDLE_HISTORY_INTERVAL_MS) {
      this.history.addEntry({ time: Math.round(now / 1000), power: view.powerW });
      if (view.powerW === 0) this.lastIdleHistoryMs = now;
      this.lastHistoryPower = view.powerW;
    }
  }

  markNoResponse(): void {
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
