[![License: MIT](https://img.shields.io/github/license/dacarson/homebridge-openevse)](LICENSE)
[![Version](https://img.shields.io/github/v/release/dacarson/homebridge-openevse)](https://github.com/dacarson/homebridge-openevse/releases)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-openevse)](https://www.npmjs.com/package/homebridge-openevse)


# homebridge-openevse

A [Homebridge](https://homebridge.io) dynamic platform plugin for **OpenEVSE** EV chargers. It talks to the charger's WiFi module over its **local HTTP API and WebSocket**: no cloud account, no login, no captcha. It's tested against OpenEVSE WiFi firmware **5.1.5**.

It's the successor to [homebridge-chargepoint](https://github.com/dacarson/homebridge-chargepoint) and keeps that plugin's Eve Energy presentation, fakegato history, throttled Eve updates and Apple Home Energy (Matter) export.

## Features

- **Eve Energy outlet**: live watts, amps and volts, plus lifetime kWh from the charger's own energy meter. Eve history graphs for power and temperature work, but [history power is capped at 6,553.5 W](#eve-history).
- **Charge now**: turn the outlet **On** to start charging immediately at full current, even when solar divert (Eco mode) would hold off.
- **Plug detection** through `Outlet In Use`.
- **EVSE temperature sensor** (optional). Its **Status Fault** is set while the EVSE reports an error: GFCI fault, no ground, stuck relay, over-temperature, over-current and so on. Errors are also logged.
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
| Temperature Sensor | Current Temperature | `temp` ÷ 10 |
| | Status Fault | `state` 4–11 (EVSE error states) |
| Accessory Information | Serial Number | EVSE controller serial (`/config` `evse_serial`) if it reports one, otherwise the WiFi module's MAC address (`/status` `macaddress`) |
| | Firmware Revision | WiFi firmware release (`/config` `version`, e.g. `v5.1.5` → `5.1.5`); left unset for non-release dev builds |
| | Model | `/config` `buildenv` (e.g. `openevse_wifi_v1`) |

The plugin also logs the EVSE controller firmware (`/config` `firmware`) at startup. HomeKit has no field for a second firmware version.

The voltage is whatever the charger reports. Unless you feed it a measured voltage, that's the configured nominal value (usually 240 V).

## Installation

In the Homebridge UI, open the **Plugins** tab, search for `homebridge-openevse` and install it.

Or install it from [npm](https://www.npmjs.com/package/homebridge-openevse) on the Homebridge host:

```bash
# hb-service installs keep plugins under /var/lib/homebridge
cd /var/lib/homebridge && sudo -u homebridge npm install homebridge-openevse
```

To update later, use the Homebridge UI or run the same command again, then restart Homebridge.

To run the latest unreleased code, install from GitHub instead: `npm install github:dacarson/homebridge-openevse`. npm builds `dist/` automatically through the `prepare` script.

From a local checkout: `npm install` (which also builds), then `npm link`.

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
| `websocket` | `true` | Live updates over `/ws`; polling continues as a fallback |
| `pollingIntervalSeconds` | `30` | Status poll interval (minimum 10). It drops to 15 s while charging if the WebSocket is down. |
| `matter` | `false` | Also publish over Matter for the Apple Home Energy view |
| `evePowerUpdates` | `"throttled"` | `"throttled"`, `"pollOnly"` or `"live"`: how Eve power/energy values are pushed |
| `minChangeWatts` / `minChangePercent` / `minChangeKwh` | `25` / `2` / `0.1` | Throttled-mode thresholds |

### Eve power & energy updates

These work the same way as in homebridge-chargepoint. `throttled` pushes a power change only when it's at least `minChangeWatts` or `minChangePercent`% (whichever is larger), an energy change of at least `minChangeKwh`, or any change once 5 minutes have passed. `pollOnly` never pushes. `live` pushes every change. On, Outlet In Use and the sensors always update immediately.

### Eve history

The plugin records Eve history (fakegato) every 10 minutes: the average charging power over those 10 minutes, plus the EVSE temperature when the temperature sensor is on. The Eve app draws its power and temperature graphs from these entries and adds up its history energy totals from them.

**History power is capped at 6,553.5 W.** The Eve history format stores power in a 16-bit field (watts × 10), so it can't hold anything higher. While the car charges faster than that, each entry is recorded as 6,553.5 W, and Eve's history graph and its history kWh read low. The faster the charging, the bigger the shortfall:

| Charging at | Eve history shows | Shortfall |
|---|---|---|
| 6.5 kW or less | the real value | none |
| 7.7 kW (32 A × 240 V) | 6.55 kW | about 15% |
| 9.6 kW (40 A × 240 V) | 6.55 kW | about 32% |
| 11.5 kW (48 A × 240 V) | 6.55 kW | about 43% |
| 19.2 kW (80 A × 240 V) | 6.55 kW | about 66% |

The first time a 10-minute window goes over the cap, the plugin logs a line saying so.

The cap only affects Eve's history. These always show the full value:

- live **Current Consumption** (W)
- **Total Consumption** (kWh), which comes straight from the charger's own lifetime meter
- the **Apple Home Energy** view through Matter

For accurate per-session or daily energy at high charging rates, use Total Consumption, Apple Home Energy or the OpenEVSE web UI rather than Eve's history graph.

**Upgrading from 1.0.1:** earlier versions recorded history wrongly. Power above 6,553.5 W wrapped around to a small number, entries were written on every poll, and the temperature graph sat at 0 °C / 32 °F. To clear those entries, open the history list in the Eve app and use **Edit**. New entries keep arriving as normal.

### Apple Home Energy (Matter)

With `"matter": true`, the charger is also published as a Matter **ElectricalSensor**, which reports voltage, current, power, cumulative energy and 15-minute periodic energy. That feeds the Apple Home Energy view without adding a second controllable tile. You need Homebridge 2.3.0+ with Matter enabled on this plugin's child bridge. Otherwise the plugin logs one line and carries on with HomeKit/Eve only.

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
  accessory.ts           Outlet (Eve Energy), temperature sensor (+ Status Fault), history, Matter
  openevse/client.ts     local HTTP API client (fetch)
  openevse/state.ts      /status -> HomeKit view, On/Off -> override action
  openevse/types.ts      API types and EVSE state codes
  eveCharacteristics.ts  Eve custom characteristic UUIDs
  eveHistory.ts          10-minute Eve history entries, power cap, temperature in history records
  eveUpdates.ts          throttled / pollOnly / live push policy
  matterEnergy.ts        optional Matter ElectricalSensor export
```

## License

MIT
