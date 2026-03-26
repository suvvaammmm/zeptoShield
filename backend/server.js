/**
 * ZeptoShield Backend v2 — Real-Time Edition
 * ─────────────────────────────────────────────
 * • MongoDB + Mongoose    → persistent storage
 * • Twilio Verify         → real SMS OTP (falls back to console log in dev)
 * • WebSocket (ws)        → live push to all connected clients
 * • node-cron             → auto weather check every 30 min
 * • Razorpay sandbox      → premium payment + payout
 * • Open-Meteo            → live weather + AQI (free, no key)
 */

const express   = require("express");
const cors      = require("cors");
const cron      = require("node-cron");
const mongoose  = require("mongoose");
const Razorpay  = require("razorpay");
const crypto    = require("crypto");
const http      = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const twilio    = require("twilio");

const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// ── ENV ──────────────────────────────────────────────────────────────────────
const {
  PORT                = 5000,
  MONGO_URI           = "mongodb://localhost:27017/zeptoshield",
  RAZORPAY_KEY_ID     = "rzp_test_YOUR_KEY",
  RAZORPAY_KEY_SECRET = "YOUR_SECRET",
  TWILIO_ACCOUNT_SID  = "",
  TWILIO_AUTH_TOKEN   = "",
  TWILIO_VERIFY_SID   = "",   // Twilio Verify Service SID (starts with VA...)
  ML_URL              = "http://localhost:8000",
  NODE_ENV            = "development",
} = process.env;

const IS_DEV      = NODE_ENV !== "production";
const USE_TWILIO  = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_VERIFY_SID);
const DEMO_OTP    = "1234"; // only used when Twilio is not configured

// ── RAZORPAY ─────────────────────────────────────────────────────────────────
const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });

// ── TWILIO ───────────────────────────────────────────────────────────────────
let twilioClient = null;
if (USE_TWILIO) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log("✅ Twilio Verify enabled — real OTPs will be sent");
} else {
  console.log(`⚠️  Twilio not configured — using demo OTP: ${DEMO_OTP}`);
}

// ── WEBSOCKET SERVER ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
  // Send welcome/ping
  ws.send(JSON.stringify({ type: "connected", message: "ZeptoShield live feed active" }));
});

/**
 * Broadcast a message to all connected WS clients.
 * Optionally filter to a specific phone number.
 */
function broadcast(payload, targetPhone = null) {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (targetPhone && ws.phone && ws.phone !== targetPhone) continue;
    ws.send(msg);
  }
}

// ── MONGOOSE SCHEMAS ─────────────────────────────────────────────────────────
const workerSchema = new mongoose.Schema({
  name:           { type: String, required: true, trim: true },
  phone:          { type: String, required: true, unique: true, trim: true },
  city:           { type: String, required: true },
  weeklyEarnings: { type: Number, default: 6000 },
  premium:        { type: Number, required: true },
  riskScore:      { type: Number, default: 0 },
  riskTier:       { type: String, enum: ["low","medium","high"], default: "medium" },
  mlBreakdown:    { type: Object, default: null },
  razorpayContactId:     { type: String, default: null },
  razorpayFundAccountId: { type: String, default: null },
  upiId:          { type: String, default: null },
  registeredAt:   { type: Date, default: Date.now },
  lastSeen:       { type: Date, default: Date.now },
}, { timestamps: true });

const policySchema = new mongoose.Schema({
  workerId:        { type: mongoose.Schema.Types.ObjectId, ref: "Worker", required: true },
  premium:         { type: Number, required: true },
  coverage:        { type: Number, default: 1500 },
  activatedAt:     { type: Date, default: Date.now },
  active:          { type: Boolean, default: true },
  razorpayOrderId: { type: String, default: null },
  paymentId:       { type: String, default: null },
  paid:            { type: Boolean, default: false },
}, { timestamps: true });

const claimSchema = new mongoose.Schema({
  workerId:         { type: mongoose.Schema.Types.ObjectId, ref: "Worker", required: true },
  eventType:        { type: String, enum: ["rain","heat","aqi","flood"] },
  eventValue:       { type: Number },
  payout:           { type: Number, default: 0 },
  status:           { type: String, enum: ["pending","approved","flagged","pending_verification"], default: "pending" },
  fraudAnalysis:    { type: Object, default: null },
  razorpayPayoutId: { type: String, default: null },
  autoTriggered:    { type: Boolean, default: false },
  weatherSnapshot:  { type: Object, default: null },
}, { timestamps: true });

// OTP records — TTL index expires them after 5 minutes
const otpSchema = new mongoose.Schema({
  phone:     { type: String, required: true, index: true },
  // For Twilio Verify we don't store the OTP here (Twilio manages it)
  // For fallback/demo we store it
  otp:       { type: String, default: null },
  attempts:  { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 300 }, // 5-min TTL
});

const sessionSchema = new mongoose.Schema({
  phone:     { type: String, required: true, index: true },
  token:     { type: String, required: true, unique: true },
  isAdmin:   { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, expires: 86400 }, // 24-hour TTL
});

const Worker    = mongoose.model("Worker",    workerSchema);
const Policy    = mongoose.model("Policy",    policySchema);
const Claim     = mongoose.model("Claim",     claimSchema);
const OTPRecord = mongoose.model("OTPRecord", otpSchema);
const Session   = mongoose.model("Session",   sessionSchema);

// ── CITY COORDS ──────────────────────────────────────────────────────────────
const CITY_COORDS = {
  Mumbai:        { lat: 19.076, lon: 72.877 },
  Chennai:       { lat: 13.082, lon: 80.270 },
  Kolkata:       { lat: 22.572, lon: 88.363 },
  Hyderabad:     { lat: 17.385, lon: 78.486 },
  Bengaluru:     { lat: 12.971, lon: 77.594 },
  Delhi:         { lat: 28.614, lon: 77.209 },
  Pune:          { lat: 18.520, lon: 73.856 },
  Ahmedabad:     { lat: 23.022, lon: 72.571 },
  Jaipur:        { lat: 26.912, lon: 75.787 },
  Surat:         { lat: 21.170, lon: 72.831 },
  Lucknow:       { lat: 26.850, lon: 80.949 },
  Bhubaneswar:   { lat: 20.296, lon: 85.824 },
  Nagpur:        { lat: 21.145, lon: 79.088 },
  Indore:        { lat: 22.719, lon: 75.857 },
  Visakhapatnam: { lat: 17.686, lon: 83.218 },
  Coimbatore:    { lat: 11.016, lon: 76.955 },
};

const THRESHOLDS = { rain: 40, heat: 42, aqi: 350, flood: 1 };

// ── SESSION HELPERS ───────────────────────────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function requireAuth(req, res, next) {
  const token = req.headers["authorization"]?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token provided" });
  const session = await Session.findOne({ token });
  if (!session) return res.status(401).json({ error: "Invalid or expired session" });
  req.session = session;
  next();
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    if (!req.session.isAdmin) return res.status(403).json({ error: "Admin access required" });
    next();
  });
}

// ── ML SERVICE ────────────────────────────────────────────────────────────────
async function callML(endpoint, body) {
  try {
    const res = await fetch(`${ML_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`ML ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`ML unavailable (${endpoint}):`, err.message);
    return null;
  }
}

function fallbackRisk(city) {
  const high = ["Mumbai","Chennai","Kolkata","Hyderabad"];
  const med  = ["Bengaluru","Delhi","Pune","Ahmedabad"];
  if (high.includes(city)) return { tier: "high",   score: 0.75, premium: 40 };
  if (med.includes(city))  return { tier: "medium", score: 0.50, premium: 30 };
  return                          { tier: "low",    score: 0.25, premium: 20 };
}

// ── WEATHER ───────────────────────────────────────────────────────────────────
async function fetchLiveWeather(city) {
  const coords = CITY_COORDS[city];
  if (!coords) return null;
  try {
    const [weatherRes, aqiRes] = await Promise.all([
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}` +
        `&current=temperature_2m,precipitation,rain,weathercode&hourly=precipitation&forecast_days=1`,
        { signal: AbortSignal.timeout(4000) }
      ),
      fetch(
        `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${coords.lat}&longitude=${coords.lon}` +
        `&current=pm10,pm2_5,us_aqi&forecast_days=1`,
        { signal: AbortSignal.timeout(4000) }
      ),
    ]);
    const weather = weatherRes.ok ? await weatherRes.json() : null;
    const aqiData = aqiRes.ok    ? await aqiRes.json()    : null;
    const hourlyRain    = weather?.hourly?.precipitation || [];
    const totalRainToday = hourlyRain.slice(0, 24).reduce((a, b) => a + (b || 0), 0);
    return {
      temperature_c:   weather?.current?.temperature_2m ?? null,
      rainfall_mm:     Math.round(totalRainToday * 10) / 10,
      current_rain_mm: weather?.current?.rain ?? 0,
      weather_code:    weather?.current?.weathercode ?? null,
      aqi:             aqiData?.current?.us_aqi ?? null,
      pm25:            aqiData?.current?.pm2_5 ?? null,
      pm10:            aqiData?.current?.pm10  ?? null,
      source:          "open-meteo",
      fetched_at:      new Date().toISOString(),
    };
  } catch (err) {
    console.warn("Weather API error:", err.message);
    return null;
  }
}

// ── RAZORPAY HELPERS ──────────────────────────────────────────────────────────
async function createRazorpayContact(worker) {
  try {
    const contact = await razorpay.contacts.create({
      name: worker.name, contact: worker.phone,
      type: "employee", reference_id: worker._id.toString(),
    });
    return contact.id;
  } catch (err) {
    console.warn("Razorpay contact:", err.message);
    return null;
  }
}

async function createFundAccount(contactId, upiId) {
  try {
    const fa = await razorpay.fundAccount.create({
      contact_id: contactId, account_type: "vpa",
      vpa: { address: upiId || "demo@upi" },
    });
    return fa.id;
  } catch (err) {
    console.warn("Fund account:", err.message);
    return null;
  }
}

async function initiatePayout(fundAccountId, amount, purpose) {
  try {
    return await razorpay.payouts.create({
      account_number: "7878780080316316",
      fund_account_id: fundAccountId,
      amount: amount * 100, currency: "INR",
      mode: "UPI", purpose, queue_if_low_balance: true,
    });
  } catch (err) {
    console.warn("Payout:", err.message);
    return { id: `pout_demo_${Date.now()}`, status: "queued" };
  }
}

// ── CRON: AUTO-TRIGGER CLAIMS ─────────────────────────────────────────────────
let lastCronRun   = null;
let lastCronStats = {};

async function runWeatherCron() {
  console.log(`\n[CRON] Weather check — ${new Date().toISOString()}`);
  lastCronRun = new Date().toISOString();

  // Broadcast cron start to admin clients
  broadcast({ type: "cron_started", timestamp: lastCronRun });

  const activePolicies = await Policy.find({ active: true }).populate("workerId");
  const cityMap = {};
  for (const policy of activePolicies) {
    if (!policy.workerId) continue;
    const city = policy.workerId.city;
    if (!cityMap[city]) cityMap[city] = [];
    cityMap[city].push(policy);
  }

  let triggered = 0;
  const results = [];

  for (const [city, policies] of Object.entries(cityMap)) {
    const weather = await fetchLiveWeather(city);
    if (!weather) { results.push({ city, status: "weather_unavailable" }); continue; }

    let eventType = null, eventValue = null;
    if (weather.rainfall_mm   >= THRESHOLDS.rain) { eventType = "rain";  eventValue = weather.rainfall_mm; }
    else if (weather.temperature_c >= THRESHOLDS.heat) { eventType = "heat"; eventValue = weather.temperature_c; }
    else if (weather.aqi       >= THRESHOLDS.aqi)  { eventType = "aqi";   eventValue = weather.aqi; }

    if (!eventType) {
      results.push({ city, status: "below_threshold", weather });
      // Broadcast weather update to workers in this city
      broadcast({ type: "weather_update", city, weather });
      continue;
    }

    for (const policy of policies) {
      const worker = policy.workerId;
      const today  = new Date(); today.setHours(0,0,0,0);
      const exists = await Claim.findOne({ workerId: worker._id, eventType, createdAt: { $gte: today } });
      if (exists) continue;

      const claim = new Claim({
        workerId: worker._id, eventType, eventValue,
        payout: policy.coverage, status: "approved",
        autoTriggered: true, weatherSnapshot: weather,
      });
      await claim.save();
      triggered++;

      if (worker.razorpayFundAccountId) {
        const payout = await initiatePayout(worker.razorpayFundAccountId, policy.coverage, "insurance");
        claim.razorpayPayoutId = payout.id;
        await claim.save();
      }

      // 🔴 Real-time push: notify the specific worker their claim fired
      broadcast({
        type:        "claim_auto_triggered",
        workerId:    worker._id.toString(),
        workerName:  worker.name,
        city,
        eventType,
        eventValue,
        payout:      policy.coverage,
        claimId:     claim._id.toString(),
        timestamp:   new Date().toISOString(),
      }, worker.phone);

      // Also push to admin channel
      broadcast({
        type: "admin_new_claim",
        claim: {
          _id: claim._id, eventType, eventValue,
          payout: policy.coverage, status: "approved",
          autoTriggered: true, createdAt: claim.createdAt,
          workerId: { name: worker.name, phone: worker.phone, city },
        },
      });

      results.push({ city, workerName: worker.name, eventType, eventValue, payout: policy.coverage, status: "claim_triggered" });
    }
  }

  lastCronStats = { checked: Object.keys(cityMap).length, triggered, timestamp: lastCronRun, results };
  broadcast({ type: "cron_complete", stats: lastCronStats });
  console.log(`[CRON] Done — checked ${Object.keys(cityMap).length} cities, triggered ${triggered} claims`);
  return lastCronStats;
}

cron.schedule("*/30 * * * *", runWeatherCron);

// ════════════════════════════════════════════════════════════════════════════
// OTP ROUTES
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/auth/send-otp
 * Body: { phone }
 * Sends real SMS via Twilio Verify, or logs demo OTP in dev mode.
 */
app.post("/api/auth/send-otp", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !/^\d{10}$/.test(phone))
      return res.status(400).json({ error: "Valid 10-digit phone number required" });

    // Rate-limit: max 3 OTP requests per 10 minutes
    const recent = await OTPRecord.countDocuments({ phone });
    if (recent >= 3)
      return res.status(429).json({ error: "Too many OTP requests. Please wait a few minutes." });

    if (USE_TWILIO) {
      // Real SMS via Twilio Verify
      await twilioClient.verify.v2
        .services(TWILIO_VERIFY_SID)
        .verifications.create({ to: `+91${phone}`, channel: "sms" });

      // Just record that a request was made (no OTP stored — Twilio manages it)
      await OTPRecord.create({ phone, otp: null });
      console.log(`[OTP] Twilio Verify SMS sent → +91${phone}`);
      return res.json({ success: true, message: "OTP sent via SMS", real: true });
    } else {
      // Dev/demo fallback — hardcoded OTP
      await OTPRecord.deleteMany({ phone });
      await OTPRecord.create({ phone, otp: DEMO_OTP });
      console.log(`[OTP] Demo OTP ${DEMO_OTP} → ${phone} (Twilio not configured)`);
      return res.json({ success: true, message: "OTP sent (demo mode)", demo: true, hint: IS_DEV ? DEMO_OTP : undefined });
    }
  } catch (err) {
    console.error("[OTP send error]", err.message);
    return res.status(500).json({ error: "Failed to send OTP. Please try again." });
  }
});

/**
 * POST /api/auth/verify-otp
 * Body: { phone, otp }
 * Returns: { token, worker?, isAdmin }
 */
app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp)
      return res.status(400).json({ error: "Phone and OTP are required" });

    let verified = false;

    if (USE_TWILIO) {
      // Verify with Twilio
      const check = await twilioClient.verify.v2
        .services(TWILIO_VERIFY_SID)
        .verificationChecks.create({ to: `+91${phone}`, code: otp });

      if (check.status !== "approved")
        return res.status(401).json({ error: "Invalid or expired OTP" });
      verified = true;
    } else {
      // Demo fallback
      const record = await OTPRecord.findOne({ phone }).sort({ createdAt: -1 });
      if (!record)
        return res.status(401).json({ error: "No OTP found. Please request a new one." });

      // Increment attempts
      record.attempts = (record.attempts || 0) + 1;
      if (record.attempts > 5) {
        await OTPRecord.deleteMany({ phone });
        return res.status(429).json({ error: "Too many attempts. Please request a new OTP." });
      }
      await record.save();

      if (record.otp !== otp)
        return res.status(401).json({ error: `Invalid OTP. ${5 - record.attempts} attempts remaining.` });
      verified = true;
    }

    if (!verified)
      return res.status(401).json({ error: "OTP verification failed" });

    // Clean up OTP record
    await OTPRecord.deleteMany({ phone });

    // Find worker
    const worker = await Worker.findOne({ phone });

    // Update lastSeen
    if (worker) {
      worker.lastSeen = new Date();
      await worker.save();
    }

    // Check if admin phone (you can set ADMIN_PHONE in .env or use a fixed one)
    const ADMIN_PHONES = (process.env.ADMIN_PHONES || "").split(",").map(p => p.trim()).filter(Boolean);
    const isAdmin = ADMIN_PHONES.includes(phone);

    // Create session token
    const token = generateToken();
    await Session.create({ phone, token, isAdmin });

    res.json({
      success:     true,
      token,
      isAdmin,
      workerExists: !!worker,
      worker:       worker || null,
    });
  } catch (err) {
    console.error("[OTP verify error]", err.message);
    return res.status(500).json({ error: "Verification failed. Please try again." });
  }
});

/**
 * POST /api/auth/logout
 */
app.post("/api/auth/logout", requireAuth, async (req, res) => {
  await Session.deleteOne({ token: req.session.token });
  res.json({ success: true });
});

/**
 * GET /api/auth/me — validate session and return current user
 */
app.get("/api/auth/me", requireAuth, async (req, res) => {
  const worker = await Worker.findOne({ phone: req.session.phone });
  const policy = worker ? await Policy.findOne({ workerId: worker._id, active: true }) : null;
  res.json({
    phone:   req.session.phone,
    isAdmin: req.session.isAdmin,
    worker:  worker || null,
    policy:  policy || null,
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WORKER ROUTES
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/workers/register
 * Requires auth token. Creates worker profile.
 */
app.post("/api/workers/register", requireAuth, async (req, res) => {
  try {
    const { name, city, weeklyEarnings, upiId } = req.body;
    const phone = req.session.phone;

    if (!name || !city)
      return res.status(400).json({ error: "Name and city are required" });

    const existing = await Worker.findOne({ phone });
    if (existing)
      return res.status(409).json({ error: "Already registered", worker: existing });

    // ML premium calculation
    const mlPremium = await callML("/ml/premium", {
      city, weekly_earnings: parseFloat(weeklyEarnings) || 6000,
      months_active: 0, previous_claims: 0,
    });
    const fb       = fallbackRisk(city);
    const premium  = mlPremium ? Math.round(mlPremium.premium)  : fb.premium;
    const riskScore= mlPremium ? mlPremium.risk_score            : fb.score;
    const riskTier = mlPremium ? (riskScore >= 0.6 ? "high" : riskScore >= 0.35 ? "medium" : "low") : fb.tier;

    const worker = new Worker({
      name, phone, city, upiId: upiId || null,
      weeklyEarnings: parseFloat(weeklyEarnings) || 6000,
      premium, riskScore, riskTier,
      mlBreakdown: mlPremium?.breakdown || null,
    });
    await worker.save();

    // Async Razorpay setup
    createRazorpayContact(worker).then(async contactId => {
      if (!contactId) return;
      await Worker.findByIdAndUpdate(worker._id, { razorpayContactId: contactId });
      if (upiId) {
        const faId = await createFundAccount(contactId, upiId);
        if (faId) await Worker.findByIdAndUpdate(worker._id, { razorpayFundAccountId: faId });
      }
    });

    // 🔴 Real-time: broadcast new registration to admin
    broadcast({
      type: "admin_new_worker",
      worker: {
        _id: worker._id, name, phone, city,
        premium, riskTier, registeredAt: worker.registeredAt,
      },
    });

    res.status(201).json({
      message: "Registered successfully",
      worker, ml_used: !!mlPremium,
    });
  } catch (err) {
    console.error("[Register error]", err);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

/**
 * GET /api/workers/me — get current user's profile + policy + claims
 */
app.get("/api/workers/me", requireAuth, async (req, res) => {
  try {
    const worker = await Worker.findOne({ phone: req.session.phone });
    if (!worker) return res.status(404).json({ error: "Worker not found" });
    const policy = await Policy.findOne({ workerId: worker._id, active: true }) || null;
    const claims = await Claim.find({ workerId: worker._id }).sort({ createdAt: -1 });
    res.json({ worker, policy, claims });
  } catch (err) {
    res.status(500).json({ error: "Failed to load profile" });
  }
});

/**
 * GET /api/workers/:phone — public lookup (for dashboard URL param compat)
 */
app.get("/api/workers/:phone", async (req, res) => {
  const worker = await Worker.findOne({ phone: req.params.phone });
  if (!worker) return res.status(404).json({ error: "Worker not found" });
  const policy = await Policy.findOne({ workerId: worker._id, active: true }) || null;
  const claims = await Claim.find({ workerId: worker._id }).sort({ createdAt: -1 });
  res.json({ worker, policy, claims });
});

/**
 * PATCH /api/workers/me/upi — update UPI ID
 */
app.patch("/api/workers/me/upi", requireAuth, async (req, res) => {
  const { upiId } = req.body;
  const worker = await Worker.findOne({ phone: req.session.phone });
  if (!worker) return res.status(404).json({ error: "Worker not found" });
  worker.upiId = upiId;
  if (worker.razorpayContactId) {
    const faId = await createFundAccount(worker.razorpayContactId, upiId);
    if (faId) worker.razorpayFundAccountId = faId;
  }
  await worker.save();
  res.json({ success: true, worker });
});

// ════════════════════════════════════════════════════════════════════════════
// PAYMENT ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/payments/create-order", requireAuth, async (req, res) => {
  try {
    const worker = await Worker.findOne({ phone: req.session.phone });
    if (!worker) return res.status(404).json({ error: "Worker not found" });
    const order = await razorpay.orders.create({
      amount: worker.premium * 100, currency: "INR",
      receipt: `policy_${worker._id}_${Date.now()}`,
      notes: { workerId: worker._id.toString(), workerName: worker.name, city: worker.city },
    });
    res.json({ order, key: RAZORPAY_KEY_ID, worker });
  } catch (err) {
    // Demo fallback
    const worker = await Worker.findOne({ phone: req.session.phone });
    res.json({
      order: { id: `order_demo_${Date.now()}`, amount: worker.premium * 100, currency: "INR" },
      key: RAZORPAY_KEY_ID, worker, demo: true,
    });
  }
});

app.post("/api/payments/verify", requireAuth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (razorpay_signature && !razorpay_order_id.startsWith("order_demo_")) {
      const expected = crypto.createHmac("sha256", RAZORPAY_KEY_SECRET)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
      if (expected !== razorpay_signature)
        return res.status(400).json({ error: "Payment verification failed" });
    }
    const worker = await Worker.findOne({ phone: req.session.phone });
    if (!worker) return res.status(404).json({ error: "Worker not found" });

    await Policy.updateMany({ workerId: worker._id }, { active: false });
    const policy = new Policy({
      workerId: worker._id, premium: worker.premium, coverage: 1500,
      razorpayOrderId: razorpay_order_id, paymentId: razorpay_payment_id, paid: true,
    });
    await policy.save();

    // 🔴 Real-time: notify worker their policy is active
    broadcast({
      type:      "policy_activated",
      workerId:  worker._id.toString(),
      policyId:  policy._id.toString(),
      premium:   worker.premium,
      coverage:  1500,
      timestamp: new Date().toISOString(),
    }, worker.phone);

    broadcast({ type: "admin_policy_activated", workerName: worker.name, city: worker.city });

    res.status(201).json({ message: "Payment verified, policy activated", policy });
  } catch (err) {
    res.status(500).json({ error: "Payment verification error" });
  }
});

// Free activation (for demo without Razorpay)
app.post("/api/policies/activate", requireAuth, async (req, res) => {
  const worker = await Worker.findOne({ phone: req.session.phone });
  if (!worker) return res.status(404).json({ error: "Worker not found" });
  const existing = await Policy.findOne({ workerId: worker._id, active: true });
  if (existing) return res.status(409).json({ error: "Policy already active", policy: existing });
  const policy = new Policy({ workerId: worker._id, premium: worker.premium, coverage: 1500 });
  await policy.save();
  broadcast({ type: "policy_activated", workerId: worker._id.toString(), premium: worker.premium }, worker.phone);
  res.status(201).json({ message: "Policy activated", policy });
});

// ════════════════════════════════════════════════════════════════════════════
// CLAIMS ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/claims/trigger", requireAuth, async (req, res) => {
  try {
    const { eventType, eventValue, location_variance, speed_consistency, device_changes, ip_mismatch, similar_cluster } = req.body;
    const worker = await Worker.findOne({ phone: req.session.phone });
    if (!worker) return res.status(404).json({ error: "Worker not found" });
    const policy = await Policy.findOne({ workerId: worker._id, active: true });
    if (!policy) return res.status(400).json({ error: "No active policy" });
    if (Number(eventValue) < (THRESHOLDS[eventType] ?? Infinity))
      return res.json({ triggered: false, message: "Threshold not met" });

    const workerClaims   = await Claim.find({ workerId: worker._id });
    const lastClaim      = workerClaims.at(-1);
    const hoursSinceLast = lastClaim ? (Date.now() - new Date(lastClaim.createdAt)) / 3_600_000 : 999;
    const claimsThisWeek = workerClaims.filter(c => Date.now() - new Date(c.createdAt) < 7 * 86_400_000).length;

    const fraudResult = await callML("/ml/fraud", {
      worker_id: worker._id, claims_per_week: claimsThisWeek,
      hours_since_activation: (Date.now() - new Date(policy.activatedAt)) / 3_600_000,
      location_variance: location_variance ?? 0.8,
      speed_consistency: speed_consistency ?? 0.75,
      device_changes_30d: device_changes ?? 0,
      ip_gps_mismatch: ip_mismatch ?? false,
      last_claim_interval_hours: hoursSinceLast,
      similar_device_cluster_size: similar_cluster ?? 0,
    });

    const claimStatus = fraudResult?.action === "flag_and_review"       ? "flagged"
                      : fraudResult?.action === "quick_verification"    ? "pending_verification"
                      : "approved";

    const claim = new Claim({
      workerId: worker._id, eventType, eventValue: Number(eventValue),
      payout: claimStatus === "approved" ? policy.coverage : 0,
      status: claimStatus, fraudAnalysis: fraudResult,
    });
    await claim.save();

    if (claimStatus === "approved" && worker.razorpayFundAccountId) {
      const payout = await initiatePayout(worker.razorpayFundAccountId, policy.coverage, "insurance");
      claim.razorpayPayoutId = payout.id;
      await claim.save();
    }

    // 🔴 Real-time: push claim result to worker's session
    broadcast({
      type:      "claim_result",
      claim:     { _id: claim._id, eventType, eventValue, payout: claim.payout, status: claimStatus, createdAt: claim.createdAt },
      message:   claimStatus === "approved" ? `₹${claim.payout} payout initiated!`
               : claimStatus === "flagged"  ? "Claim flagged for review"
               : "Quick verification required",
    }, worker.phone);

    broadcast({ type: "admin_new_claim", claim: { ...claim.toObject(), workerId: { name: worker.name, phone: worker.phone, city: worker.city } } });

    res.status(201).json({ triggered: true, claim, fraud_check: fraudResult, ml_used: !!fraudResult,
      message: claimStatus === "approved" ? `Claim approved. ₹${claim.payout} payout initiated.`
             : claimStatus === "flagged"  ? "Claim flagged for manual review."
             : "Claim pending — quick verification required." });
  } catch (err) {
    console.error("[Claim trigger error]", err);
    res.status(500).json({ error: "Claim trigger failed" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// WEATHER ROUTE
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/weather/:city", async (req, res) => {
  const weather = await fetchLiveWeather(req.params.city);
  if (!weather) return res.status(503).json({ error: "Weather unavailable" });
  const mlProfile = await callML("/ml/risk-profile", {
    city: req.params.city,
    current_rainfall_mm: weather.rainfall_mm,
    current_temp_c:      weather.temperature_c,
    current_aqi:         weather.aqi,
    flood_alert:         false,
  });
  res.json({ city: req.params.city, weather, ml_risk_profile: mlProfile });
});

// ════════════════════════════════════════════════════════════════════════════
// STATS + ADMIN ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/stats", async (_req, res) => {
  const [totalWorkers, activePolicies, allClaims] = await Promise.all([
    Worker.countDocuments(),
    Policy.countDocuments({ active: true }),
    Claim.find(),
  ]);
  const today = new Date(); today.setHours(0,0,0,0);
  res.json({
    totalWorkers, activePolicies,
    totalClaims:    allClaims.length,
    claimsToday:    allClaims.filter(c => new Date(c.createdAt) >= today).length,
    approvedClaims: allClaims.filter(c => c.status === "approved").length,
    flaggedClaims:  allClaims.filter(c => c.status === "flagged").length,
    totalPayout:    allClaims.filter(c => c.status === "approved").reduce((s, c) => s + c.payout, 0),
  });
});

app.get("/api/admin/workers",  requireAdmin, async (_req, res) => res.json(await Worker.find().sort({ registeredAt: -1 }).limit(100)));
app.get("/api/admin/claims",   requireAdmin, async (_req, res) => res.json(await Claim.find().populate("workerId","name phone city").sort({ createdAt: -1 }).limit(100)));
app.get("/api/admin/policies", requireAdmin, async (_req, res) => res.json(await Policy.find({ active: true }).populate("workerId","name phone city premium").sort({ activatedAt: -1 })));

app.post("/api/admin/run-cron", requireAdmin, async (_req, res) => {
  const result = await runWeatherCron();
  res.json({ success: true, result });
});

app.get("/api/admin/cron-status", requireAdmin, (_req, res) => res.json({
  lastRun: lastCronRun, schedule: "every 30 minutes", stats: lastCronStats,
  nextRun: lastCronRun ? new Date(new Date(lastCronRun).getTime() + 30 * 60_000).toISOString() : "pending",
}));

// ── BOOT ─────────────────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => console.log(`✅ MongoDB connected → ${MONGO_URI}`))
  .catch(err => console.warn(`⚠️  MongoDB error: ${err.message}`));

server.listen(PORT, () => {
  console.log(`\n🛡  ZeptoShield API     → http://localhost:${PORT}`);
  console.log(`🔌 WebSocket           → ws://localhost:${PORT}`);
  console.log(`💳 Razorpay mode       → ${RAZORPAY_KEY_ID.startsWith("rzp_test") ? "SANDBOX" : "LIVE"}`);
  console.log(`📱 OTP mode            → ${USE_TWILIO ? "Twilio Verify (real SMS)" : `Demo (code: ${DEMO_OTP})`}`);
  console.log(`⏰ Cron schedule        → every 30 minutes\n`);
});
