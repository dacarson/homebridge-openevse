import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { actionForOn, deviceInfo, mergeEvent, viewFromStatus } from '../src/openevse/state';
import { OpenEvseClient } from '../src/openevse/client';

describe('viewFromStatus', () => {
  it('reports charging power, current and temperature in SI units', () => {
    const v = viewFromStatus({ state: 3, vehicle: 1, amp: 31500, voltage: 241, power: 7591, temp: 345, total_energy: 812.4 }, null);
    assert.equal(v.on, true);
    assert.equal(v.charging, true);
    assert.equal(v.pluggedIn, true);
    assert.equal(v.currentA, 31.5);
    assert.equal(v.powerW, 7591);
    assert.equal(v.voltageV, 241);
    assert.equal(v.temperatureC, 34.5);
    assert.equal(v.totalKwh, 812.4);
    assert.equal(v.fault, false);
  });

  it('computes power from V x A when the firmware reports 0 W', () => {
    const v = viewFromStatus({ state: 3, amp: 10000, voltage: 240, power: 0 }, null);
    assert.equal(v.powerW, 2400);
  });

  it('zeroes power when not charging and handles missing temperature', () => {
    const v = viewFromStatus({ state: 254, vehicle: 1, amp: 300, power: 72, temp: false }, null);
    assert.equal(v.on, false);
    assert.equal(v.powerW, 0);
    assert.equal(v.currentA, 0);
    assert.equal(v.pluggedIn, true);
    assert.equal(v.temperatureC, null);
  });

  it('flags faults', () => {
    const v = viewFromStatus({ state: 6 }, null);
    assert.equal(v.fault, true);
    assert.equal(v.faultName, 'GFCI fault');
  });

  it('override state decides On', () => {
    assert.equal(viewFromStatus({ state: 2, manual_override: 1 }, { state: 'active' }).on, true);
    assert.equal(viewFromStatus({ state: 3, manual_override: 1 }, { state: 'disabled' }).on, false);
    assert.equal(viewFromStatus({ state: 2, divertmode: 2 }, null).mode, 'eco');
  });
});

describe('actionForOn', () => {
  it('On creates an auto-released active override', () => {
    assert.deepEqual(actionForOn(true, null, false), { kind: 'override', props: { state: 'active', auto_release: true } });
    assert.deepEqual(actionForOn(true, null, false, 32),
      { kind: 'override', props: { state: 'active', auto_release: true, charge_current: 32 } });
    assert.deepEqual(actionForOn(true, { state: 'active' }, true), { kind: 'none' });
  });

  it('Off releases an active override, or pauses automatic charging', () => {
    assert.deepEqual(actionForOn(false, { state: 'active' }, true), { kind: 'release' });
    assert.deepEqual(actionForOn(false, null, true), { kind: 'override', props: { state: 'disabled', auto_release: true } });
    assert.deepEqual(actionForOn(false, null, false), { kind: 'none' });
    assert.deepEqual(actionForOn(false, { state: 'disabled' }, false), { kind: 'none' });
  });
});

describe('mergeEvent', () => {
  it('overlays partial websocket events', () => {
    assert.deepEqual(mergeEvent({ state: 2, amp: 0 }, { amp: 16000, state: 3 }), { state: 3, amp: 16000 });
  });
});

describe('OpenEvseClient against a mock charger', () => {
  let server: http.Server;
  let client: OpenEvseClient;
  const requests: { method: string; url: string; body: string; auth?: string }[] = [];
  let override: Record<string, unknown> | null = null;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        requests.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/status') return res.end(JSON.stringify({ state: 3, amp: 16000 }));
        if (req.url === '/override') {
          if (req.method === 'GET') return res.end(JSON.stringify(override ?? {}));
          if (req.method === 'POST') { override = JSON.parse(body); res.statusCode = 201; return res.end('{"msg":"Created"}'); }
          if (req.method === 'DELETE') {
            if (!override) { res.statusCode = 500; return res.end('{"msg":"Failed to release manual override"}'); }
            override = null; return res.end('{"msg":"Deleted"}');
          }
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    client = new OpenEvseClient({ host: `127.0.0.1:${port}`, username: 'admin', password: 'pw' });
  });

  after(() => server.close());

  it('reads status with basic auth', async () => {
    const st = await client.getStatus();
    assert.equal(st.amp, 16000);
    assert.equal(requests.at(-1)!.auth, 'Basic ' + Buffer.from('admin:pw').toString('base64'));
  });

  it('sets, reads and clears the override', async () => {
    assert.equal(await client.getOverride(), null);
    await client.setOverride({ state: 'active', auto_release: true });
    assert.deepEqual(await client.getOverride(), { state: 'active', auto_release: true });
    await client.clearOverride();
    assert.equal(await client.getOverride(), null);
    await client.clearOverride(); // 500 when nothing to release is not an error
  });

  it('builds the websocket URL', () => {
    assert.match(client.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
  });
});

describe('deviceInfo', () => {
  const st = { macaddress: 'aa:bb:cc:dd:ee:ff' };

  it('uses the EVSE controller serial when it reports one', () => {
    const d = deviceInfo({ evse_serial: 'OE123456', version: 'v5.1.5', firmware: '8.2.2', buildenv: 'openevse_wifi_v1' }, st, 'host');
    assert.equal(d.serialNumber, 'OE123456');
    assert.equal(d.serialSource, 'evse_serial');
    assert.equal(d.firmwareRevision, '5.1.5');
    assert.equal(d.controllerFirmware, '8.2.2');
    assert.equal(d.model, 'openevse_wifi_v1');
  });

  it('falls back to the MAC address when there is no usable serial', () => {
    for (const evse_serial of [undefined, '', '0', '000000', '-']) {
      const d = deviceInfo({ evse_serial, version: 'v5.1.5' }, st, 'host');
      assert.equal(d.serialNumber, 'AA:BB:CC:DD:EE:FF');
      assert.equal(d.serialSource, 'mac');
    }
  });

  it('then the ESP chip id, then the fallback id', () => {
    assert.equal(deviceInfo({ wifi_serial: '9C9C1F123456' }, {}, 'host').serialNumber, '9C9C1F123456');
    assert.equal(deviceInfo({}, {}, 'host').serialNumber, 'host');
  });

  it('reports the WiFi firmware release, not the controller firmware', () => {
    assert.equal(deviceInfo({ version: 'v5.1.5', firmware: '8.2.2' }, st, 'h').firmwareRevision, '5.1.5');
    assert.equal(deviceInfo({ version: '5.1.5_modified' }, st, 'h').firmwareRevision, '5.1.5');
    assert.equal(deviceInfo({ version: 'local_master_fd2e8430' }, st, 'h').firmwareRevision, null);
    assert.equal(deviceInfo({ firmware: '8.2.2' }, st, 'h').firmwareRevision, null);
  });
});
