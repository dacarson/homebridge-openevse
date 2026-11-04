[![License: MIT](https://img.shields.io/github/license/dacarson/homebridge-openevse)](LICENSE)

# homebridge-openevse

A [Homebridge](https://homebridge.io) dynamic platform plugin for **OpenEVSE** EV chargers. It talks to the charger's WiFi module over its **local HTTP API and WebSocket**: no cloud account, no login, no captcha. It's tested against OpenEVSE WiFi firmware **5.1.5**.

It's the successor to [homebridge-chargepoint](https://github.com/dacarson/homebridge-chargepoint) and keeps that plugin's Eve Energy presentation, fakegato history, throttled Eve updates and Apple Home Energy (Matter) export.

## Features

- **Eve Energy outlet**: live watts, amps and volts, plus lifetime kWh from the charger's own energy meter. Eve history graphs work.
- **Charge now**: turn the outlet **On** to start charging immediately at full current, even when solar divert (Eco mode) would hold off.
- **Plug detection** through `Outlet In Use`.
- **EVSE temperature sensor** (optional).
- **Fault sensor** (optional): a contact sensor that opens on a GFCI fault, no ground, a stuck relay, over-temperature, over-current or another EVSE error, so you can get HomeKit notifications.
- **Live updates** pushed over the charger's `/ws` WebSocket, with polling as a fallback.
- **Apple Home Energy view** through Matter (optional, Homebridge 2.3+).
- "No Response" in HomeKit when the charger is unreachable.

## How On/Off works

OpenEVSE decides what to do by **claims**, which rank in this order: Eco divert (50) < schedule timers (100) < API/automation claims (500) < **manual override (1000)** < OCPP (1050) < safety limits. This plugin only uses the **manual override**, the same one as the button in the OpenEVSE web UI.

| You do | Plugin does | Result |
|---|---|---|
| Turn **On** | `POST /override {"state":"active","auto_release":true}` | Charges now at `chargeNowCurrent` or the charger's max, beating Eco mode and any policy script |
| Turn **Off** while a charge-now override is active | `DELETE /override` | Back to automatic (Eco divert, schedules, `openevse_manager.py`). If there's enough solar, it may keep charging. |
| Turn **Off** while charging automatically (e.g. from solar) | `POST /override {"state":"disabled","auto_release":true}` | Paused until you unplug or turn it On |
| Turn **Off** while not charging | nothing | An "Off" automation never blocks solar charging that hasn't started yet |

Overrides are **auto-released when the car is unplugged**, so the next session always starts in automatic mode.

**The On value reads** true while an active override is in place, false while a paused override is in place, and otherwise follows whether the EVSE is actually charging.

### The car still decides

The charger only tells the car how much current it may draw. If the car's own schedule says "not now" or the battery is full, turning the outlet On won't make it charge. For automations to work reliably, turn off the car's charging schedule.

## HomeKit services

| Service | Characteristic | Source (`/status`) |
|---|---|---|
| Outlet | On (read/write) | see above |
| | Outlet In Use | `vehicle` |
| | Current Consumption (W, Eve) | `power` (or V × A) while charging |
| | Total Consumption (kWh, Eve) | `total_energy`, the charger's lifetime meter |
| | Voltage (V, Eve) | `voltage` |
| | Electric Current (A, Eve) | `amp` ÷ 1000 while charging |
| Temperature Sensor | Current Temperature, Status Fault | `temp` ÷ 10 |
| Contact Sensor ("Fault") | Contact Sensor State (open = fault), Status Fault | `state` 4–11 |
| Accessory Information | Serial Number | EVSE controller serial (`/config` `evse_serial`) if it reports one, otherwise the WiFi module's MAC address (`/status` `macaddress`) |
| | Firmware Revision | WiFi firmware release (`/config` `version`, e.g. `v5.1.5` → `5.1.5`); left unset for non-release dev builds |
| | Model | `/config` `buildenv` (e.g. `openevse_wifi_v1`) |

The plugin also logs the EVSE controller firmware (`/config` `firmware`) at startup. HomeKit has no field for a second firmware version.

The voltage is whatever the charger reports. Unless you feed it a measured voltage, that's the configured nominal value (usually 240 V).

## Installation

The plugin isn't on npm yet. Install it straight from GitHub on the Homebridge host. npm builds `dist/` automatically on install, through the `prepare` script.

```bash
# hb-service installs keep plugins under /var/lib/homebridge
cd /var/lib/homebridge && sudo -u homebridge npm install github:dacarson/homebridge-openevse
```

To update later, run the same command again and restart Homebridge.

From a local checkout instead: `npm install` (which also builds), then `npm link`.

## Configuration

```json
{
  "platform": "OpenEVSE",
  "name": "Garage Charger",
  "host": "openevse.local"
}
```

| Key | Default | Description |
|---|---|---|
| `host` | **required** | Hostname or IP of the OpenEVSE WiFi module |
| `name` | `OpenEVSE` | Accessory name |
| `username` / `password` | – | Only if web UI authentication is enabled |
| `chargeNowCurrent` | charger max | Amps to use when turned On |
| `temperatureSensor` | `true` | Show the EVSE temperature sensor |
| `faultSensor` | `true` | Show the fault contact sensor |
| `websocket` | `true` | Live updates over `/ws`; polling continues as a fallback |
| `pollingIntervalSeconds` | `30` | Status poll interval (minimum 10). It drops to 15 s while charging if the WebSocket is down. |
| `matter` | `false` | Also publish over Matter for the Apple Home Energy view |
| `evePowerUpdates` | `"throttled"` | `"throttled"`, `"pollOnly"` or `"live"`: how Eve power/energy values are pushed |
| `minChangeWatts` / `minChangePercent` / `minChangeKwh` | `25` / `2` / `0.1` | Throttled-mode thresholds |

### Eve power & energy updates

These work the same way as in homebridge-chargepoint. `throttled` pushes a power change only when it's at least `minChangeWatts` or `minChangePercent`% (whichever is larger), an energy change of at least `minChangeKwh`, or any change once 5 minutes have passed. `pollOnly` never pushes. `live` pushes every change. On, Outlet In Use and the sensors always update immediately.

With the WebSocket enabled, the charger pushes a status update every few seconds while charging, so throttling matters more here than it did with ChargePoint polling.

### Apple Home Energy (Matter)

With `"matter": true`, the charger is also published as a Matter **ElectricalSensor**, which reports voltage, current, power, cumulative energy and 15-minute periodic energy. That feeds the Apple Home Energy view without adding a second controllable tile. You need Homebridge 2.3.0+ with Matter enabled on this plugin's child bridge. Otherwise the plugin logs one line and carries on with HomeKit/Eve only.

## Solar divert, MQTT and OCPP

This plugin doesn't need MQTT or OCPP:

- **Solar divert** is driven by feeding the charger grid import/export readings. Firmware 5.1.5 accepts these over HTTP (`POST /status {"grid_ie": W}`), so no broker is required. See [openevse-sunpower-chargemanager](https://github.com/dacarson/openevse-sunpower-chargemanager), which feeds it from a SunPower PVS6 and adds TOU rules.
- **OCPP** isn't recommended alongside this plugin. OCPP claims (1050) outrank the manual override, and it turns Homebridge into the charger's backend.

## Development

```bash
npm install
npm run build
npm test      # node:test unit tests, including a mock charger HTTP server
```

```
src/
  index.ts               registers the platform
  platform.ts            discovery, polling, WebSocket, reconnects
  accessory.ts           Outlet (Eve Energy), temperature + fault sensors, history, Matter
  openevse/client.ts     local HTTP API client (fetch)
  openevse/state.ts      /status -> HomeKit view, On/Off -> override action
  openevse/types.ts      API types and EVSE state codes
  eveCharacteristics.ts  Eve custom characteristic UUIDs
  eveUpdates.ts          throttled / pollOnly / live push policy
  matterEnergy.ts        optional Matter ElectricalSensor export
```

## License

MIT
