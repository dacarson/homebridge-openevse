import { EVSE_STATE, FAULT_NAMES } from './types';
import type { EvseProperties, OpenEvseConfig, OpenEvseStatus } from './types';

export interface ChargerView {
  /** Value for the Outlet's On characteristic. */
  on: boolean;
  /** Vehicle plugged in (Outlet In Use). */
  pluggedIn: boolean;
  charging: boolean;
  powerW: number;
  currentA: number;
  voltageV: number;
  /** Lifetime energy from the charger's own meter (kWh, monotonic). */
  totalKwh: number;
  temperatureC: number | null;
  fault: boolean;
  faultName: string | null;
  /** 'override-on' | 'override-off' | 'eco' | 'normal' — for logging. */
  mode: string;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Maps /status (plus the current override, if known) onto what HomeKit shows.
 *
 * On semantics:
 *   - an "active" manual override  -> On (the user asked to charge now)
 *   - a "disabled" manual override -> Off (the user paused charging)
 *   - no override                  -> On while the EVSE is actually charging
 *     (e.g. solar divert or the overnight policy is running it)
 */
export function viewFromStatus(st: OpenEvseStatus, override: EvseProperties | null): ChargerView {
  const state = num(st.state);
  const charging = state === EVSE_STATE.CHARGING;
  const currentA = charging ? (num(st.amp) ?? 0) / 1000 : 0;
  const voltageV = num(st.voltage) ?? 240;
  let powerW = charging ? (num(st.power) ?? 0) : 0;
  if (charging && powerW <= 0 && currentA > 0) powerW = currentA * voltageV;

  const tempRaw = num(st.temp);
  const fault = state !== null && FAULT_NAMES[state] !== undefined;

  const hasOverride = st.manual_override === 1 || override !== null;
  let on = charging;
  let mode = st.divertmode === 2 ? 'eco' : 'normal';
  if (hasOverride && override?.state === 'active') {
    on = true;
    mode = 'override-on';
  } else if (hasOverride && override?.state === 'disabled') {
    on = false;
    mode = 'override-off';
  }

  return {
    on,
    pluggedIn: st.vehicle === 1 || charging,
    charging,
    powerW: Math.max(0, powerW),
    currentA: Math.max(0, currentA),
    voltageV,
    totalKwh: Math.max(0, num(st.total_energy) ?? 0),
    temperatureC: tempRaw === null ? null : Math.round(tempRaw) / 10,
    fault,
    faultName: fault ? FAULT_NAMES[state!] : null,
    mode,
  };
}

/**
 * What a HomeKit On/Off write should do.
 *  - On  -> manual override "active" (optionally at a fixed current), auto-released on unplug
 *  - Off -> if an "active" override is in place, release it (back to Eco/auto);
 *           otherwise, if it is charging, pause with a "disabled" override (held until
 *           unplug or On); if it isn't charging, do nothing (so an "Off" automation never
 *           blocks solar charging that hasn't started yet).
 */
export type OnAction =
  | { kind: 'override'; props: EvseProperties }
  | { kind: 'release' }
  | { kind: 'none' };

export function actionForOn(
  turnOn: boolean,
  override: EvseProperties | null,
  charging: boolean,
  chargeNowCurrent?: number,
): OnAction {
  if (turnOn) {
    if (override?.state === 'active') return { kind: 'none' };
    const props: EvseProperties = { state: 'active', auto_release: true };
    if (chargeNowCurrent && chargeNowCurrent > 0) props.charge_current = Math.round(chargeNowCurrent);
    return { kind: 'override', props };
  }
  if (override?.state === 'active') return { kind: 'release' };
  if (override?.state === 'disabled' || !charging) return { kind: 'none' };
  return { kind: 'override', props: { state: 'disabled', auto_release: true } };
}

/** Merge a partial /ws event into the last known status. */
export function mergeEvent(prev: OpenEvseStatus, event: Record<string, unknown>): OpenEvseStatus {
  return { ...prev, ...event };
}

export interface DeviceInfo {
  model: string;
  serialNumber: string;
  /** HAP-safe "x.y.z" WiFi firmware version, or null for dev builds. */
  firmwareRevision: string | null;
  /** Raw WiFi firmware string as reported (for logging). */
  wifiFirmware: string | null;
  controllerFirmware: string | null;
  serialSource: 'evse_serial' | 'mac' | 'wifi_serial' | 'fallback';
}

const usable = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '' && !/^[0\s.:-]*$/.test(v) && v.trim() !== '-';

/**
 * AccessoryInformation for the charger.
 *  - Serial: the EVSE controller serial if it reports one; otherwise the WiFi module's
 *    MAC address (from /status); then the ESP chip id; then the fallback id.
 *  - Firmware: the WiFi firmware release ("v5.1.5" -> "5.1.5"), which is the version
 *    shown in the web UI and the one OTA updates change.
 */
export function deviceInfo(config: OpenEvseConfig, status: OpenEvseStatus, fallbackId: string): DeviceInfo {
  let serialNumber: string;
  let serialSource: DeviceInfo['serialSource'];
  if (usable(config.evse_serial)) {
    serialNumber = config.evse_serial.trim();
    serialSource = 'evse_serial';
  } else if (usable(status.macaddress)) {
    serialNumber = String(status.macaddress).trim().toUpperCase();
    serialSource = 'mac';
  } else if (usable(config.wifi_serial)) {
    serialNumber = config.wifi_serial.trim();
    serialSource = 'wifi_serial';
  } else {
    serialNumber = fallbackId;
    serialSource = 'fallback';
  }

  const wifiFirmware = usable(config.version) ? config.version.trim() : null;
  const m = wifiFirmware?.replace(/^v/i, '').match(/^\d+(\.\d+){0,2}/);
  return {
    model: usable(config.buildenv) ? String(config.buildenv) : 'OpenEVSE WiFi',
    serialNumber,
    firmwareRevision: m ? m[0] : null,
    wifiFirmware,
    controllerFirmware: usable(config.firmware) ? config.firmware.trim() : null,
    serialSource,
  };
}
