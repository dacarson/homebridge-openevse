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
 * Eve.app treats every energy history entry as a 10-minute sample: it shows each one as
 * power / 6 Wh and ignores the timestamps. Power is stored as a 16-bit "watts x 10"
 * value, so 6685 W wraps around and reads as 131.7 W.
 *
 * EveEnergyHistory integrates power over each 10-minute window and returns entries for
 * it. If the window's average power is too big for one entry, the window is split into
 * several entries that each fit and together add up to the same energy. Eve sums the
 * entries, so its kWh totals stay right at any charging power. The per-entry limit is
 * 3276.7 W (signed 16-bit), so the result is the same whether Eve reads the field as
 * signed or unsigned.
 */
export const EVE_HISTORY_INTERVAL_MS = 10 * 60 * 1000;
export const EVE_HISTORY_MAX_POWER_W = 3276.7;
// Polls run at least every 30 s; a longer silence means the charger was unreachable,
// so only this much of a gap is credited at the last known power.
export const EVE_HISTORY_MAX_GAP_MS = 2 * 60 * 1000;

export class EveEnergyHistory {
  private energyWs = 0;
  private lastPowerW = 0;
  private lastSampleMs: number | null = null;

  /** Record the charger's power at `nowMs` (it applies until the next sample). */
  sample(powerW: number, nowMs: number): void {
    this.integrateTo(nowMs);
    this.lastPowerW = Number.isFinite(powerW) && powerW > 0 ? powerW : 0;
  }

  /** Close the current window; returns the power values (W) of the entries to add. */
  flush(nowMs: number): number[] {
    this.integrateTo(nowMs);
    const averageW = this.energyWs / (EVE_HISTORY_INTERVAL_MS / 1000);
    this.energyWs = 0;
    if (averageW <= EVE_HISTORY_MAX_POWER_W) return [round1(averageW)];
    const parts = Math.ceil(averageW / EVE_HISTORY_MAX_POWER_W);
    return Array.from({ length: parts }, () => round1(averageW / parts));
  }

  private integrateTo(nowMs: number): void {
    if (this.lastSampleMs !== null && nowMs > this.lastSampleMs) {
      const dtMs = Math.min(nowMs - this.lastSampleMs, EVE_HISTORY_MAX_GAP_MS);
      this.energyWs += this.lastPowerW * dtMs / 1000;
    }
    if (this.lastSampleMs === null || nowMs > this.lastSampleMs) this.lastSampleMs = nowMs;
  }
}

function round1(w: number): number {
  return Math.min(EVE_HISTORY_MAX_POWER_W, Math.round(w * 10) / 10);
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
