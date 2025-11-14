# HomeKit Prayer Times Integration

Provides a HomeKit bridge that exposes five switch accessories for daily prayer times (Fajr, Dhuhr, Asr, Maghrib, Isha). Use these switches in Home automations to play the Azan on a HomePod or trigger any scene when the switch pulses ON at the scheduled time.

## Requirements
- Node.js 18+ (uses global `fetch`)
- Packages: `hap-nodejs`, `node-cron`, `luxon`, `dotenv`
- London Prayer Times API URL (`LPT_API_URL`) and API key (`LPT_API_KEY`)

## Install
- Run: `npm install hap-nodejs node-cron luxon dotenv`

## Configure
- Create a `.env` file next to `prayer-bridge.js`.
- Required variables:

```env
LPT_API_URL=http://www.londonprayertimes.com/api/times/
LPT_API_KEY=your_api_key
```

- Optional variables with defaults:

```env
TIMEZONE=Europe/London
CRON_SPEC_FETCH="1 0 * * *"
SWITCH_PULSE_SECONDS=30
RETRY_FETCH_MINUTES=10
HAP_USERNAME=AA:12:3D:D3:BE:A6
HAP_PIN=012-34-567
HAP_PORT=51827
FAJR_OFFSET_MINUTES=45
DHUHR_OFFSET_MINUTES=0
ASR_OFFSET_MINUTES=0
MAGHRIB_OFFSET_MINUTES=0
ISHA_OFFSET_MINUTES=0
# AccessoryInformation
BRIDGE_MANUFACTURER=Prayer Bridge
BRIDGE_SERIAL_NUMBER=PB-0001
BRIDGE_MODEL=HomeKit-Prayer-Bridge
BRIDGE_FIRMWARE=1.0.0
```

## Run
- Start the bridge: `node prayer-bridge.js`
- The bridge publishes as "Prayer Bridge" with PIN `012-34-567` by default.

## Pair and Automate
- In the Apple Home app, add the accessory and enter the PIN.
- Create five automations:
  - When `Fajr Switch` turns ON → play Azan on HomePod (or any action)
  - When `Dhuhr Switch` turns ON → play Azan on HomePod (or any action)
  - When `Asr Switch` turns ON → play Azan on HomePod (or any action)
  - When `Maghrib Switch` turns ON → play Azan on HomePod (or any action)
  - When `Isha Switch` turns ON → play Azan on HomePod (or any action)

## How It Works
- Object-oriented design:
  - `PrayerSwitch` manages individual switch state and pulsing.
  - `HomeKitBridge` builds and publishes the bridge with five switches and sets AccessoryInformation.
  - `PrayerTimesService` fetches and normalizes times from `LPT_API_URL`.
  - `Scheduler` schedules pulses based on today’s times and per-prayer offsets.
  - `App` orchestrates publishing, fetching, scheduling, and daily refresh.
- Fetches daily London prayer times and schedules pulses for the current day.
- Each switch pulses ON for `SWITCH_PULSE_SECONDS` and then turns OFF.
- Daily refresh runs at local `00:01` from `CRON_SPEC_FETCH`, using `TIMEZONE`.
- If fetching fails, it retries after `RETRY_FETCH_MINUTES`.

## Notes
- Per-prayer offsets are controlled by env variables (defaults add 45 minutes to Fajr).
- Time calculations use `luxon` with the configured `TIMEZONE`.
