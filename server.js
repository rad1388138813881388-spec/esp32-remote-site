const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const mqtt = require("mqtt");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const required = ["MQTT_HOST", "MQTT_USERNAME", "MQTT_PASSWORD", "CONTROL_PASSWORD", "SESSION_SECRET"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));
app.use(session({
  name: "esp32.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 12 * 60 * 60 * 1000
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const TOPICS = {
  state: "home/esp32/relay/state",
  status: "home/esp32/status",
  set: (id) => `home/esp32/relay/${id}/set`
};

let mqttConnected = false;
let deviceStatus = "UNKNOWN";
let relayState = { relay1: false, relay2: false, relay3: false, relay4: false };
let lastStateAt = null;

const mqttClient = mqtt.connect(`mqtts://${process.env.MQTT_HOST}:8883`, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  clientId: `webpanel_${Math.random().toString(16).slice(2, 10)}`,
  clean: true,
  connectTimeout: 15000,
  reconnectPeriod: 5000,
  keepalive: 30,
  rejectUnauthorized: true
});

mqttClient.on("connect", () => {
  mqttConnected = true;
  console.log("Connected to EMQX over TLS");
  mqttClient.subscribe([TOPICS.state, TOPICS.status], { qos: 1 }, (err) => {
    if (err) console.error("Subscribe error:", err.message);
  });
});
mqttClient.on("reconnect", () => console.log("Reconnecting to EMQX..."));
mqttClient.on("close", () => { mqttConnected = false; });
mqttClient.on("offline", () => { mqttConnected = false; });
mqttClient.on("error", (err) => console.error("MQTT error:", err.message));

mqttClient.on("message", (topic, payload) => {
  const value = payload.toString();
  if (topic === TOPICS.state) {
    try {
      const parsed = JSON.parse(value);
      for (let i = 1; i <= 4; i++) {
        const key = `relay${i}`;
        if (typeof parsed[key] === "boolean") relayState[key] = parsed[key];
      }
      lastStateAt = new Date().toISOString();
    } catch (e) {
      console.error("Invalid relay state JSON");
    }
  } else if (topic === TOPICS.status) {
    deviceStatus = value;
  }
});

function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ error: "لطفاً ابتدا وارد شوید." });
}

app.post("/api/login", loginLimiter, (req, res) => {
  const password = req.body && req.body.password;
  if (typeof password !== "string" || password.length > 200 ||
      password !== process.env.CONTROL_PASSWORD) {
    return res.status(401).json({ error: "رمز ورود اشتباه است." });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "خطا در ورود." });
    req.session.loggedIn = true;
    res.json({ ok: true });
  });
});

app.post("/api/logout", requireLogin, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("esp32.sid", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict"
    });
    res.json({ ok: true });
  });
});

app.get("/api/state", requireLogin, (req, res) => {
  res.json({
    mqttConnected,
    deviceStatus,
    relayState,
    lastStateAt
  });
});

app.post("/api/relay/:id/set", requireLogin, (req, res) => {
  const id = Number(req.params.id);
  const value = req.body && req.body.value;
  if (![1, 2, 3, 4].includes(id) || !["ON", "OFF"].includes(value)) {
    return res.status(400).json({ error: "فرمان نامعتبر است." });
  }
  if (!mqttConnected) {
    return res.status(503).json({ error: "ارتباط سرور با EMQX قطع است." });
  }
  mqttClient.publish(TOPICS.set(id), value, { qos: 1, retain: false }, (err) => {
    if (err) return res.status(502).json({ error: "ارسال فرمان ناموفق بود." });
    res.json({ ok: true, message: "فرمان ارسال شد." });
  });
});

app.get("/api/session", (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.loggedIn) });
});

app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: "1h"
}));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Web panel listening on port ${PORT}`));
