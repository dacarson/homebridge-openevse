# Changelog

## Unreleased

- Build against Homebridge 2.x (`devDependencies.homebridge` is now `^2.1.0`, matching the `>=2.1.0` requirement Matter support needs).
- Drop the separate `hap-nodejs` peer and dev dependency. `Perms`/`Formats` and the `Characteristic` type now come from `homebridge`, so users no longer install a second copy of HAP-NodeJS alongside Homebridge's own.
- Fix the Eve temperature graph sitting flat at 0 °C / 32 °F. History entries now store the charger temperature, and it's sent to Eve. Entries recorded before this fix still show 0.
- Fix Eve history energy totals. Eve counts every history entry as a 10-minute sample, but entries were written on every poll (about every 30 s), and power above 6,553.5 W wrapped around (6.7 kW was recorded as 132 W). History now gets one entry per 10 minutes with the average power over that window. A window averaging more than 3,276.7 W is split into several entries that together hold the right energy.

## 1.0.1

- First public release on npm.
- Matter accessory now reports the charger's real serial number and model, instead of the fixed "Home Flex" model. Registration waits until the charger's details are known.
- Limit the Matter serial number and model to 32 characters.

## 1.0.0

- Pin the `hap-nodejs` dev dependency to match Homebridge's so a clean install builds.

## 0.1.0

- Initial release: successor to homebridge-chargepoint for OpenEVSE chargers.
- Local HTTP API + `/ws` WebSocket (no cloud account).
- Eve Energy outlet (W, A, V, lifetime kWh from the charger's meter) with fakegato history.
- On = manual override "charge now" (auto-released on unplug); Off releases it or pauses automatic charging.
- Optional EVSE temperature sensor; EVSE errors set its Status Fault.
- Optional Apple Home Energy view via Matter (carried over from homebridge-chargepoint 1.3.0).
- `evePowerUpdates` throttling carried over from homebridge-chargepoint 1.3.0.
