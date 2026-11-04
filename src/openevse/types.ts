/**
 * Subset of the OpenEVSE WiFi firmware (v5.x) /status document used by the plugin.
 * Units are the firmware's default scaling: amp in mA, temperatures in 0.1 degC,
 * power in W, session_energy in Wh, total_energy in kWh. Fields that are unavailable
 * are reported as `false` by the firmware.
 */
export interface OpenEvseStatus {
  state?: number;            // EVSE controller state, see EVSE_STATE
  status?: 'active' | 'disabled' | string;
  vehicle?: number;          // 1 = vehicle connected
  amp?: number;              // mA
  voltage?: number;          // V
  power?: number;            // W
  pilot?: number;            // A, current pilot
  max_current?: number;      // A
  temp?: number | false;     // 0.1 degC
  temp_max?: number | false;
  session_energy?: number;   // Wh
  total_energy?: number;     // kWh
  manual_override?: number;  // 1 if a manual override is active
  divertmode?: number;       // 1 normal, 2 eco
  divert_active?: boolean;
  charge_rate?: number;
  override_version?: number;
  config_version?: number;
  [key: string]: unknown;
}

export interface OpenEvseConfig {
  /** EVSE controller (ATmega) firmware, e.g. "8.2.2". Only present once the EVSE has booted. */
  firmware?: string;
  /** WiFi module firmware release tag, e.g. "v5.1.5" (dev builds: "local_<branch>_<hash>"). */
  version?: string;
  /** EVSE controller serial number (RAPI $SN); empty if the controller doesn't report one. */
  evse_serial?: string;
  /** ESP32 chip id of the WiFi module. */
  wifi_serial?: string;
  buildenv?: string;
  hostname?: string;
  min_current_hard?: number;
  max_current_soft?: number;
  max_current_hard?: number;
  [key: string]: unknown;
}

/** Properties used by /override (and claims). */
export interface EvseProperties {
  state?: 'active' | 'disabled';
  charge_current?: number;
  max_current?: number;
  auto_release?: boolean;
}

export const EVSE_STATE = {
  STARTING: 0,
  NOT_CONNECTED: 1,
  CONNECTED: 2,
  CHARGING: 3,
  SLEEPING: 254,
  DISABLED: 255,
} as const;

export const FAULT_NAMES: Record<number, string> = {
  4: 'vent required',
  5: 'diode check failed',
  6: 'GFCI fault',
  7: 'no ground',
  8: 'stuck relay',
  9: 'GFCI self-test failed',
  10: 'over temperature',
  11: 'over current',
};
