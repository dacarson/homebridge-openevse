# Changelog

## 1.0.0

- First public release on npm.
- Pin the `hap-nodejs` dev dependency to match Homebridge's so a clean install builds.

## 0.1.0

- Initial release: successor to homebridge-chargepoint for OpenEVSE chargers.
- Local HTTP API + `/ws` WebSocket (no cloud account).
- Eve Energy outlet (W, A, V, lifetime kWh from the charger's meter) with fakegato history.
- On = manual override "charge now" (auto-released on unplug); Off releases it or pauses automatic charging.
- Optional EVSE temperature sensor; EVSE errors set its Status Fault.
- Optional Apple Home Energy view via Matter (carried over from homebridge-chargepoint 1.3.0).
- `evePowerUpdates` throttling carried over from homebridge-chargepoint 1.3.0.
