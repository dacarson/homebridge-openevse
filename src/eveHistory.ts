/**
 * Eve's "energy" history record (as written by fakegato-history) has slots for
 * temperature, humidity and power, but fakegato always writes 0 for temperature.
 * Eve only draws the temperature series when the accessory has a CurrentTemperature
 * characteristic, so once the temperature sensor is enabled the graph shows a flat
 * 0 °C / 32 °F. These helpers fill the real temperature into those records.
 *
 * Energy record layout (little-endian), 0x14 = 20 bytes:
 *   [0] length 0x14  [1..4] entry #  [5..8] time  [9] mask 0x1f
 *   [10..11] temp ×100  [12..13] humidity ×100  [14..15] power ×10  [16..19] unused
 * Other records (e.g. the 0x15 reference-time record) are left untouched.
 */
/**
 * Eve.app turns each energy history entry into energy as power x (time since the
 * previous entry), so an entry's power covers the interval that ends at its timestamp.
 * Power is stored as a 16-bit "watts x 10" value: above 6553.5 W it wraps around
 * (9.2 kW is recorded as about 2.6 kW). Splitting into several entries can't get around
 * this, because they share the same time span, so Eve history can't show a sustained
 * power above the limit. EveEnergyHistory writes one entry per 10 minutes with the
 * window's time-weighted average power, capped at the limit instead of wrapping.
 */
export const EVE_HISTORY_INTERVAL_MS = 10 * 60 * 1000;
export const EVE_HISTORY_MAX_POWER_W = 6553.5;
// Polls run at least every 30 s; a longer silence means the charger was unreachable,
// so only this much of a gap is credited at the last known power.
export const EVE_HISTORY_MAX_GAP_MS = 2 * 60 * 1000;

export interface HistoryWindow {
  powerW: number;   // value to record, capped at EVE_HISTORY_MAX_POWER_W
  averageW: number; // actual average power over the window
}

export class EveEnergyHistory {
  private energyWs = 0;
  private lastPowerW = 0;
  private lastSampleMs: number | null = null;
  private windowStartMs: number | null = null;

  /** Record the charger's power at `nowMs` (it applies until the next sample). */
  sample(powerW: number, nowMs: number): void {
    this.integrateTo(nowMs);
    this.lastPowerW = Number.isFinite(powerW) && powerW > 0 ? powerW : 0;
  }

  /** Close the current window and return the power to record for it. */
  flush(nowMs: number): HistoryWindow {
    this.integrateTo(nowMs);
    const start = this.windowStartMs ?? nowMs;
    const seconds = (nowMs - start) / 1000;
    const averageW = seconds > 0 ? this.energyWs / seconds : 0;
    this.energyWs = 0;
    this.windowStartMs = nowMs;
    return { powerW: Math.min(EVE_HISTORY_MAX_POWER_W, round1(averageW)), averageW: round1(averageW) };
  }

  private integrateTo(nowMs: number): void {
    if (this.windowStartMs === null) this.windowStartMs = nowMs;
    if (this.lastSampleMs !== null && nowMs > this.lastSampleMs) {
      const dtMs = Math.min(nowMs - this.lastSampleMs, EVE_HISTORY_MAX_GAP_MS);
      this.energyWs += this.lastPowerW * dtMs / 1000;
    }
    if (this.lastSampleMs === null || nowMs > this.lastSampleMs) this.lastSampleMs = nowMs;
  }
}

function round1(w: number): number {
  return Math.round(w * 10) / 10;
}

const ENERGY_RECORD_LENGTH = 0x14;
const ENERGY_RECORD_MASK = 0x1f;
const TEMP_OFFSET = 10;

/** Rewrite the temperature of every energy record in an S2R2 history chunk (base64). */
export function fillEnergyHistoryTemperatures(
  base64: string,
  tempForEntry: (entry: number) => number | undefined,
): string {
  const buf = Buffer.from(base64, 'base64');
  let changed = false;
  for (let pos = 0; pos < buf.length;) {
    const len = buf[pos];
    if (len === 0 || pos + len > buf.length) break;
    if (len === ENERGY_RECORD_LENGTH && buf[pos + 9] === ENERGY_RECORD_MASK) {
      const temp = tempForEntry(buf.readUInt32LE(pos + 1));
      if (temp !== undefined && Number.isFinite(temp)) {
        const raw = Math.max(-32768, Math.min(32767, Math.round(temp * 100)));
        buf.writeInt16LE(raw, pos + TEMP_OFFSET);
        changed = true;
      }
    }
    pos += len;
  }
  return changed ? buf.toString('base64') : base64;
}
