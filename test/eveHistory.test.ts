import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVE_HISTORY_INTERVAL_MS,
  EVE_HISTORY_MAX_POWER_W,
  EveEnergyHistory,
  fillEnergyHistoryTemperatures,
} from '../src/eveHistory';

// Records exactly as fakegato-history formats them for the 'energy' type.
const refRecord = (entry: number) =>
  '15' + le32(entry) + '0100 0000 81' + le32(0x2a000000) + '0000 0000 00 0000';
const energyRecord = (entry: number, powerW: number) =>
  '14' + le32(entry) + le32(600) + '1f' + '0000 0000' + le16(powerW * 10) + '0000 0000';

function le32(n: number): string {
  const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b.toString('hex');
}
function le16(n: number): string {
  const b = Buffer.alloc(2); b.writeUInt16LE(n); return b.toString('hex');
}
const b64 = (hex: string) => Buffer.from(hex.replace(/[^0-9a-f]/gi, ''), 'hex').toString('base64');

describe('fillEnergyHistoryTemperatures', () => {
  it('fills temperature into energy records and leaves other records alone', () => {
    const input = b64(refRecord(1) + energyRecord(2, 3000) + energyRecord(3, 0));
    const temps: Record<number, number> = { 2: 34.5, 3: -4.25 };
    const out = Buffer.from(fillEnergyHistoryTemperatures(input, e => temps[e]), 'base64');
    const inBuf = Buffer.from(input, 'base64');

    assert.deepEqual(out.subarray(0, 21), inBuf.subarray(0, 21)); // ref record untouched
    assert.equal(out.readInt16LE(21 + 10), 3450);
    assert.equal(out.readUInt16LE(21 + 14), 30000); // power untouched
    assert.equal(out.readInt16LE(41 + 10), -425);
    assert.equal(out.length, inBuf.length);
  });

  it('leaves entries without a stored temperature at 0', () => {
    const input = b64(energyRecord(5, 100));
    assert.equal(fillEnergyHistoryTemperatures(input, () => undefined), input);
  });

  it('passes through the empty end-of-history marker', () => {
    assert.equal(fillEnergyHistoryTemperatures(b64('00'), () => 20), b64('00'));
  });
});

describe('EveEnergyHistory', () => {
  const MIN = 60_000;
  const W = EVE_HISTORY_INTERVAL_MS;

  // Samples every 30 s, as the poller/websocket would.
  function run(h: EveEnergyHistory, powerAt: (t: number) => number, from: number, to: number): void {
    for (let t = from; t < to; t += 30_000) h.sample(powerAt(t), t);
  }

  it('records the time-weighted average power for each window', () => {
    const h = new EveEnergyHistory();
    run(h, t => (t < 5 * MIN ? 3000 : 0), 0, W);
    assert.deepEqual(h.flush(W), { powerW: 1500, averageW: 1500 });
  });

  it('records 0 for an idle window', () => {
    const h = new EveEnergyHistory();
    run(h, () => 0, 0, W);
    assert.deepEqual(h.flush(W), { powerW: 0, averageW: 0 });
  });

  it('caps power above 6553.5 W instead of letting it wrap', () => {
    const h = new EveEnergyHistory();
    run(h, () => 9183, 0, W);
    const { powerW, averageW } = h.flush(W);
    assert.equal(powerW, EVE_HISTORY_MAX_POWER_W);
    assert.ok(powerW * 10 <= 0xffff);
    assert.equal(averageW, 9183);
  });

  it('averages over the actual window length', () => {
    const h = new EveEnergyHistory();
    run(h, () => 1200, 0, 4 * MIN);
    assert.equal(h.flush(4 * MIN).powerW, 1200);
  });

  it('splits power between windows at the boundary', () => {
    const h = new EveEnergyHistory();
    run(h, () => 0, 0, 5 * MIN);
    run(h, () => 1200, 5 * MIN, W);
    // The 30 s since the last sample is credited to this window at the last power.
    assert.equal(h.flush(W).powerW, 600);
    run(h, () => 1200, W, 2 * W);
    assert.equal(h.flush(2 * W).powerW, 1200);
  });

  it('does not credit power across a long outage', () => {
    const h = new EveEnergyHistory();
    h.sample(6000, 0);
    // Charger unreachable for 10 minutes: only the 2-minute gap allowance counts.
    assert.equal(h.flush(W).powerW, 1200);
  });
});
