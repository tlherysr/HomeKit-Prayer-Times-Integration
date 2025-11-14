import "dotenv/config";
import cron from "node-cron";
import { DateTime } from "luxon";
import { uuid, Accessory, Bridge, Categories, Service, Characteristic } from "hap-nodejs";

const config = {
  TIMEZONE: process.env.TIMEZONE || "Europe/London",
  CRON_SPEC_FETCH: process.env.CRON_SPEC_FETCH || "1 0 * * *",
  LPT_API_URL: process.env.LPT_API_URL,
  LPT_API_KEY: process.env.LPT_API_KEY || "",
  SWITCH_PULSE_SECONDS: Number(process.env.SWITCH_PULSE_SECONDS || 30),
  FAJR_OFFSET_MINUTES: Number(process.env.FAJR_OFFSET_MINUTES || 45),
  DHUHR_OFFSET_MINUTES: Number(process.env.DHUHR_OFFSET_MINUTES || 0),
  ASR_OFFSET_MINUTES: Number(process.env.ASR_OFFSET_MINUTES || 0),
  MAGHRIB_OFFSET_MINUTES: Number(process.env.MAGHRIB_OFFSET_MINUTES || 0),
  ISHA_OFFSET_MINUTES: Number(process.env.ISHA_OFFSET_MINUTES || 0),
  RETRY_FETCH_MINUTES: Number(process.env.RETRY_FETCH_MINUTES || 10),
  HAP_USERNAME: process.env.HAP_USERNAME || "AA:12:3D:D3:BE:A6",
  HAP_PIN: process.env.HAP_PIN || "012-34-567",
  HAP_PORT: Number(process.env.HAP_PORT || 51827),
  BRIDGE_MANUFACTURER: process.env.BRIDGE_MANUFACTURER || "Prayer Bridge",
  BRIDGE_SERIAL_NUMBER: process.env.BRIDGE_SERIAL_NUMBER || "PB-0001",
  BRIDGE_MODEL: process.env.BRIDGE_MODEL || "HomeKit-Prayer-Bridge",
  BRIDGE_FIRMWARE: process.env.BRIDGE_FIRMWARE || "1.0.0",
};

class PrayerSwitch {
  constructor(name) {
    this.name = name;
    const key = name.toLowerCase();
    this.key = key;
    const accUUID = uuid.generate(`hap.prayer.switch.${key}`);
    this.accessory = new Accessory(`${name} Switch`, accUUID);
    this.accessory.category = Categories.SWITCH;
    this.service = this.accessory.addService(new Service.Switch(`${name} Switch`));
    this.state = false;
    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.state)
      .onSet((value) => {
        this.state = !!value;
        console.log(`[HAP] ${name} Switch set to ${this.state}`);
      });
  }

  async pulse(seconds) {
    if (this.state) {
      this.state = false;
      this.service.updateCharacteristic(Characteristic.On, false);
      await new Promise((res) => setTimeout(res, 500));
    }
    console.log(`[HAP] Pulsing ${this.name} Switch ON for ${seconds}s`);
    this.state = true;
    this.service.updateCharacteristic(Characteristic.On, true);
    await new Promise((res) => setTimeout(res, seconds * 1000));
    this.state = false;
    this.service.updateCharacteristic(Characteristic.On, false);
  }
}

class HomeKitBridge {
  constructor() {
    this.bridge = new Bridge("Prayer Bridge", uuid.generate("hap.prayer.bridge"));
    this.switches = {};
    for (const name of ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]) {
      const sw = new PrayerSwitch(name);
      this.switches[name.toLowerCase()] = sw;
      this.bridge.addBridgedAccessory(sw.accessory);
    }
  }

  publish() {
    const info = this.bridge.getService(Service.AccessoryInformation);
    if (info) {
      info.setCharacteristic(Characteristic.Manufacturer, config.BRIDGE_MANUFACTURER);
      info.setCharacteristic(Characteristic.SerialNumber, config.BRIDGE_SERIAL_NUMBER);
      info.setCharacteristic(Characteristic.Model, config.BRIDGE_MODEL);
      info.setCharacteristic(Characteristic.FirmwareRevision, config.BRIDGE_FIRMWARE);
    }
    this.bridge.publish({
      username: config.HAP_USERNAME,
      pincode: config.HAP_PIN,
      port: config.HAP_PORT,
      category: Categories.BRIDGE,
    });
    console.log(`[HAP] Bridge published. Pair "Prayer Bridge" in Home using PIN ${config.HAP_PIN}.`);
  }
}

class PrayerTimesService {
  constructor() {}

  async fetch(dateISO) {
    if (!config.LPT_API_KEY) throw new Error("Missing LPT_API_KEY in .env");
    if (!config.LPT_API_URL) throw new Error("Missing LPT_API_URL in .env");
    
    const url = new URL(config.LPT_API_URL);
    url.search = new URLSearchParams({
      format: "json",
      key: config.LPT_API_KEY,
      city: "london",
      "24hours": "true",
      date: dateISO,
    }).toString();
    console.log(`[Fetch] Requesting times for ${dateISO} -> ${url.toString()}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(url, { method: "GET", signal: controller.signal });
      if (!resp.ok) throw new Error(`LPT fetch failed: ${resp.status} ${resp.statusText}`);
      const data = await resp.json();
      const times = this.normalize(data);
      this.validate(times);
      return times;
    } finally {
      clearTimeout(timeout);
    }
  }

  normalize(data) {
    const candidates = {
      fajr: data.fajr,
      dhuhr: data.dhuhr,
      asr: data.asr_2,
      maghrib: data.magrib || data.maghrib,
      isha: data.isha,
    };
    const out = {};
    for (const k of ["fajr", "dhuhr", "asr", "maghrib", "isha"]) {
      out[k] = this.normalizeHHMM(candidates[k]);
    }
    return out;
  }

  normalizeHHMM(v) {
    if (!v || typeof v !== "string") return null;
    const parts = v.trim().split(":").map((p) => p.trim());
    if (parts.length < 2) return null;
    let [H, M] = parts;
    if (H.length === 1) H = `0${H}`;
    if (M.length === 1) M = `0${M}`;
    return `${H}:${M}`;
  }

  validate(times) {
    const missing = Object.entries(times)
      .filter(([_, v]) => !v)
      .map(([k]) => k);
    if (missing.length) throw new Error(`Missing prayer times: ${missing.join(", ")}`);
  }
}

class Scheduler {
  constructor(bridge) {
    this.bridge = bridge;
    this.timers = [];
  }

  clear() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  schedule(times) {
    this.clear();
    const now = DateTime.now().setZone(config.TIMEZONE);
    console.log(`[Scheduler] Scheduling for ${now.toISODate()} (${config.TIMEZONE})`, times);
    const map = { fajr: "Fajr", dhuhr: "Dhuhr", asr: "Asr", maghrib: "Maghrib", isha: "Isha" };
    for (const [key, display] of Object.entries(map)) {
      const hhmm = times[key];
      if (!hhmm) {
        console.warn(`[Scheduler] Missing time for ${key}, skipping`);
        continue;
      }
      const [HH, MM] = hhmm.split(":").map(Number);
      let dt = now.set({ hour: HH, minute: MM, second: 0, millisecond: 0 });
      const offsetMin = {
        fajr: config.FAJR_OFFSET_MINUTES,
        dhuhr: config.DHUHR_OFFSET_MINUTES,
        asr: config.ASR_OFFSET_MINUTES,
        maghrib: config.MAGHRIB_OFFSET_MINUTES,
        isha: config.ISHA_OFFSET_MINUTES,
      }[key] || 0;
      dt = dt.plus({ minutes: offsetMin });
      if (dt <= now) {
        console.log(`[Scheduler] ${display} at ${dt.toISO()} has passed; skipping`);
        continue;
      }
      const msUntil = dt.diff(now, "milliseconds").milliseconds;
      console.log(`[Scheduler] ${display} will pulse at ${dt.toFormat("HH:mm")} (${dt.toISO()}) in ${(msUntil / 60000).toFixed(1)} min`);
      const sw = this.bridge.switches[display.toLowerCase()];
      if (!sw) continue;
      const handle = setTimeout(async () => {
        try {
          await sw.pulse(config.SWITCH_PULSE_SECONDS);
        } catch (err) {
          console.error(`[Scheduler] Error pulsing ${display}: ${err.message}`);
        }
      }, msUntil);
      this.timers.push(handle);
    }
  }
}

class App {
  constructor() {
    this.bridge = new HomeKitBridge();
    this.service = new PrayerTimesService();
    this.scheduler = new Scheduler(this.bridge);
    this.prayerTimes = null;
  }

  async planToday() {
    const now = DateTime.now().setZone(config.TIMEZONE);
    try {
      const times = await this.service.fetch(now.toISODate());
      this.prayerTimes = times;
      console.log("[Plan] Today prayer times:", times);
      this.scheduler.schedule(times);
    } catch (err) {
      console.error("[Plan] Fetch failed:", err.message);
      const retryAt = now.plus({ minutes: config.RETRY_FETCH_MINUTES });
      const ms = retryAt.diff(now, "milliseconds").milliseconds;
      console.log(`[Plan] Will retry at ${retryAt.toISO()} (~${config.RETRY_FETCH_MINUTES} min)`);
      setTimeout(() => this.planToday(), ms);
    }
  }

  async start() {
    this.bridge.publish();
    await this.planToday();
    cron.schedule(config.CRON_SPEC_FETCH, () => {
      console.log("[Cron] 00:01 daily refresh triggered");
      this.planToday();
    }, { timezone: config.TIMEZONE });
    console.log(`[Scheduler] Daily fetch scheduled at "00:01" local time (${config.TIMEZONE}).`);
  }
}

const app = new App();
await app.start();
