/**
 * ZeptoShield Backend — Node.js + Express
 * Port: 5000
 *
 * Integrations:
 *   - Python ML service  → http://localhost:8000
 *   - Open-Meteo API     → free, no key needed (weather + AQI)
 *   - Razorpay sandbox   → premium payment + claim payout
 *   - node-cron          → auto-trigger claims every 30 min
 *   - MongoDB + Mongoose → persistent storage
 *   - OTP auth           → hardcoded demo OTP: 1234
 */

const express   = require("express");
const cors      = require("cors");
const cron      = require("node-cron");
const mongoose  = require("mongoose");
const Razorpay  = require("razorpay");
const crypto    = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// ── ENV CONFIG ──────────────────────────────────────────────────────────────
const ML_URL              = process.env.ML_URL              || "http://localhost:8000";
const MONGO_URI           = process.env.MONGO_URI           || "mongodb://localhost:27017/zeptoshield";
const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID     || "rzp_test_YOUR_KEY_ID";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "YOUR_KEY_SECRET";
const DEMO_OTP            = "1234";

// ── RAZORPAY CLIENT ─────────────────────────────────────────────────────────
const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });

// ── MONGOOSE MODELS ─────────────────────────────────────────────────────────
const workerSchema = new mongoose.Schema({
  name:           String,
  phone:          { type: String, unique: true },
  city:           String,
  weeklyEarnings: Number,
  premium:        Number,
  riskScore:      Number,
  riskTier:       String,
  mlBreakdown:    Object,
  razorpayContactId:     String,
  razorpayFundAccountId: String,
  registeredAt:   { type: Date, default: Date.now },
});

const policySchema = new mongoose.Schema({
  workerId:        { type: mongoose.Schema.Types.ObjectId, ref: "Worker" },
  premium:         Number,
  coverage:        { type: Number, default: 1500 },
  activatedAt:     { type: Date, default: Date.now },
  active:          { type: Boolean, default: true },
  razorpayOrderId: String,
  paymentId:       String,
  paid:            { type: Boolean, default: false },
});

const claimSchema = new mongoose.Schema({
  workerId:         { type: mongoose.Schema.Types.ObjectId, ref: "Worker" },
  eventType:        String,
  eventValue:       Number,
  payout:           Number,
  status:           { type: String, default: "pending" },
  fraudAnalysis:    Object,
  razorpayPayoutId: String,
  autoTriggered:    { type: Boolean, default: false },
  createdAt:        { type: Date, default: Date.now },
});

const otpSchema = new mongoose.Schema({
  phone:     String,
  otp:       String,
  createdAt: { type: Date, default: Date.now, expires: 300 },
});

const Worker    = mongoose.model("Worker",    workerSchema);
const Policy    = mongoose.model("Policy",    policySchema);
const Claim     = mongoose.model("Claim",     claimSchema);
const OTPRecord = mongoose.model("OTPRecord", otpSchema);

// ── CITY COORDS ─────────────────────────────────────────────────────────────
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

// ── ML SERVICE ───────────────────────────────────────────────────────────────
async function callML(endpoint, body) {
  try {
    const res = await fetch(`${ML_URL}${endpoint}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`ML ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`ML unavailable (${endpoint}):`, err.message);
    return null;
  }
}

// ── WEATHER FETCHER ──────────────────────────────────────────────────────────
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
        `&current=pm10,pm2_5,us_aqi&hourly=us_aqi&forecast_days=1`,
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
      pm10:            aqiData?.current?.pm10 ?? null,
      source:          "open-meteo",
      fetched_at:      new Date().toISOString(),
    };
  } catch (err) {
    console.warn("Weather API error:", err.message);
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

// ── RAZORPAY HELPERS ─────────────────────────────────────────────────────────
async function createRazorpayContact(worker) {
  try {
    const contact = await razorpay.contacts.create({
      name: worker.name, contact: worker.phone,
      type: "employee", reference_id: worker._id.toString(),
    });
    return contact.id;
  } catch (err) {
    console.warn("Razorpay contact failed:", err.message);
    return null;
  }
}

async function createFundAccount(contactId, upiId) {
  try {
    const fa = await razorpay.fundAccount.create({
      contact_id:   contactId,
      account_type: "vpa",
      vpa:          { address: upiId || "demo@upi" },
    });
    return fa.id;
  } catch (err) {
    console.warn("Fund account failed:", err.message);
    return null;
  }
}

async function initiatePayout(fundAccountId, amount, purpose) {
  try {
    return await razorpay.payouts.create({
      account_number: "7878780080316316",
      fund_account_id: fundAccountId,
      amount:   amount * 100,
      currency: "INR",
      mode:     "UPI",
      purpose,
      queue_if_low_balance: true,
    });
  } catch (err) {
    console.warn("Payout failed:", err.message);
    return { id: `pout_demo_${Date.now()}`, status: "queued" };
  }
}

// ── CRON: AUTO-TRIGGER CLAIMS ─────────────────────────────────────────────────
let lastCronRun   = null;
let lastCronStats = {};

async function runWeatherCron() {
  console.log(`\n[CRON] Weather check — ${new Date().toISOString()}`);
  lastCronRun = new Date().toISOString();

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
    if (weather.rainfall_mm  >= THRESHOLDS.rain) { eventType = "rain"; eventValue = weather.rainfall_mm; }
    else if (weather.temperature_c >= THRESHOLDS.heat) { eventType = "heat"; eventValue = weather.temperature_c; }
    else if (weather.aqi >= THRESHOLDS.aqi)       { eventType = "aqi";  eventValue = weather.aqi; }

    if (!eventType) { results.push({ city, status: "below_threshold", weather }); continue; }

    for (const policy of policies) {
      const worker = policy.workerId;
      const today  = new Date(); today.setHours(0,0,0,0);
      const exists = await Claim.findOne({ workerId: worker._id, eventType, createdAt: { $gte: today } });
      if (exists) continue;

      const claim = new Claim({
        workerId: worker._id, eventType, eventValue,
        payout: policy.coverage, status: "approved", autoTriggered: true,
      });
      await claim.save();
      triggered++;

      if (worker.razorpayFundAccountId) {
        const payout = await initiatePayout(worker.razorpayFundAccountId, policy.coverage, "insurance");
        claim.razorpayPayoutId = payout.id;
        await claim.save();
      }

      results.push({ city, workerName: worker.name, eventType, eventValue, payout: policy.coverage, status: "claim_triggered" });
    }
  }

  lastCronStats = { checked: Object.keys(cityMap).length, triggered, timestamp: lastCronRun, results };
  console.log(`[CRON] Done — checked ${Object.keys(cityMap).length} cities, triggered ${triggered} claims`);
  return lastCronStats;
}

cron.schedule("*/30 * * * *", runWeatherCron);

// ════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════

// OTP AUTH
app.post("/api/auth/send-otp", async (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length !== 10)
    return res.status(400).json({ error: "Valid 10-digit phone required" });
  await OTPRecord.deleteMany({ phone });
  await OTPRecord.create({ phone, otp: DEMO_OTP });
  console.log(`[OTP] Demo OTP ${DEMO_OTP} → ${phone}`);
  res.json({ success: true, message: "OTP sent (demo: use 1234)", demo: true });
});

app.post("/api/auth/verify-otp", async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: "Phone and OTP required" });
  const record = await OTPRecord.findOne({ phone });
  if (!record || record.otp !== otp)
    return res.status(401).json({ error: "Invalid or expired OTP" });
  await OTPRecord.deleteMany({ phone });
  const worker = await Worker.findOne({ phone });
  res.json({ success: true, verified: true, workerExists: !!worker, worker: worker || null });
});

// WEATHER
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

// WORKERS
app.post("/api/workers/register", async (req, res) => {
  const { name, phone, city, weeklyEarnings } = req.body;
  if (!name || !phone || !city)
    return res.status(400).json({ error: "name, phone and city are required" });
  const existing = await Worker.findOne({ phone });
  if (existing) return res.status(409).json({ error: "Already registered", worker: existing });

  const mlPremium = await callML("/ml/premium", {
    city, weekly_earnings: parseFloat(weeklyEarnings) || 6000,
    months_active: 0, previous_claims: 0,
  });
  const fb = fallbackRisk(city);
  const premium   = mlPremium ? Math.round(mlPremium.premium) : fb.premium;
  const riskScore = mlPremium ? mlPremium.risk_score : fb.score;
  const riskTier  = mlPremium ? (riskScore >= 0.6 ? "high" : riskScore >= 0.35 ? "medium" : "low") : fb.tier;

  const worker = new Worker({
    name, phone, city,
    weeklyEarnings: parseFloat(weeklyEarnings) || 6000,
    premium, riskScore, riskTier,
    mlBreakdown: mlPremium?.breakdown || null,
  });
  await worker.save();

  createRazorpayContact(worker).then(contactId => {
    if (contactId) Worker.findByIdAndUpdate(worker._id, { razorpayContactId: contactId }).exec();
  });

  res.status(201).json({ message: "Registered successfully", worker, ml_used: !!mlPremium });
});

app.get("/api/workers/:phone", async (req, res) => {
  const worker = await Worker.findOne({ phone: req.params.phone });
  if (!worker) return res.status(404).json({ error: "Worker not found" });
  const policy = await Policy.findOne({ workerId: worker._id, active: true }) || null;
  const claims = await Claim.find({ workerId: worker._id }).sort({ createdAt: -1 });
  res.json({ worker, policy, claims });
});

app.post("/api/workers/:phone/upi", async (req, res) => {
  const { upiId } = req.body;
  const worker = await Worker.findOne({ phone: req.params.phone });
  if (!worker) return res.status(404).json({ error: "Worker not found" });
  if (worker.razorpayContactId) {
    const faId = await createFundAccount(worker.razorpayContactId, upiId);
    if (faId) { worker.razorpayFundAccountId = faId; await worker.save(); }
  }
  res.json({ success: true, message: "UPI saved for payouts" });
});

// PAYMENTS
app.post("/api/payments/create-order", async (req, res) => {
  const { workerId } = req.body;
  const worker = await Worker.findById(workerId);
  if (!worker) return res.status(404).json({ error: "Worker not found" });
  try {
    const order = await razorpay.orders.create({
      amount: worker.premium * 100, currency: "INR",
      receipt: `policy_${worker._id}_${Date.now()}`,
      notes: { workerId: worker._id.toString(), workerName: worker.name, city: worker.city },
    });
    res.json({ order, key: RAZORPAY_KEY_ID, worker });
  } catch (err) {
    console.error("Razorpay order failed:", err.message);
    res.json({
      order: { id: `order_demo_${Date.now()}`, amount: worker.premium * 100, currency: "INR" },
      key: RAZORPAY_KEY_ID, worker, demo: true,
    });
  }
});

app.post("/api/payments/verify", async (req, res) => {
  const { workerId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (razorpay_signature && !razorpay_order_id.startsWith("order_demo_")) {
    const expected = crypto.createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id).digest("hex");
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: "Payment verification failed" });
  }
  const worker = await Worker.findById(workerId);
  if (!worker) return res.status(404).json({ error: "Worker not found" });
  await Policy.updateMany({ workerId: worker._id }, { active: false });
  const policy = new Policy({
    workerId: worker._id, premium: worker.premium, coverage: 1500,
    razorpayOrderId: razorpay_order_id, paymentId: razorpay_payment_id, paid: true,
  });
  await policy.save();
  res.status(201).json({ message: "Payment verified, policy activated", policy });
});

// POLICIES (legacy)
app.post("/api/policies/activate", async (req, res) => {
  const { workerId } = req.body;
  const worker = await Worker.findById(workerId);
  if (!worker) return res.status(404).json({ error: "Worker not found" });
  const existing = await Policy.findOne({ workerId, active: true });
  if (existing) return res.status(409).json({ error: "Already active", policy: existing });
  const policy = new Policy({ workerId, premium: worker.premium, coverage: 1500 });
  await policy.save();
  res.status(201).json({ message: "Policy activated", policy });
});

// CLAIMS
app.post("/api/claims/trigger", async (req, res) => {
  const { workerId, eventType, eventValue,
          location_variance, speed_consistency, device_changes, ip_mismatch, similar_cluster } = req.body;
  const worker = await Worker.findById(workerId);
  if (!worker) return res.status(404).json({ error: "Worker not found" });
  const policy = await Policy.findOne({ workerId, active: true });
  if (!policy) return res.status(400).json({ error: "No active policy" });
  if (Number(eventValue) < (THRESHOLDS[eventType] ?? Infinity))
    return res.json({ triggered: false, message: "Threshold not met" });

  const workerClaims   = await Claim.find({ workerId });
  const lastClaim      = workerClaims.at(-1);
  const hoursSinceLast = lastClaim ? (Date.now() - new Date(lastClaim.createdAt)) / 3_600_000 : 999;
  const claimsThisWeek = workerClaims.filter(c => Date.now() - new Date(c.createdAt) < 7 * 86_400_000).length;

  const fraudResult = await callML("/ml/fraud", {
    worker_id: workerId, claims_per_week: claimsThisWeek,
    hours_since_activation: (Date.now() - new Date(policy.activatedAt)) / 3_600_000,
    location_variance: location_variance ?? 0.8, speed_consistency: speed_consistency ?? 0.75,
    device_changes_30d: device_changes ?? 0, ip_gps_mismatch: ip_mismatch ?? false,
    last_claim_interval_hours: hoursSinceLast, similar_device_cluster_size: similar_cluster ?? 0,
  });

  let claimStatus = "approved";
  if (fraudResult?.action === "flag_and_review")      claimStatus = "flagged";
  else if (fraudResult?.action === "quick_verification") claimStatus = "pending_verification";

  const claim = new Claim({
    workerId, eventType, eventValue: Number(eventValue),
    payout: claimStatus === "approved" ? policy.coverage : 0,
    status: claimStatus, fraudAnalysis: fraudResult,
  });
  await claim.save();

  if (claimStatus === "approved" && worker.razorpayFundAccountId) {
    const payout = await initiatePayout(worker.razorpayFundAccountId, policy.coverage, "insurance");
    claim.razorpayPayoutId = payout.id;
    await claim.save();
  }

  res.status(201).json({
    triggered: true, claim, fraud_check: fraudResult, ml_used: !!fraudResult,
    message: claimStatus === "approved"
      ? `Claim approved. ₹${claim.payout} payout initiated.`
      : claimStatus === "flagged" ? "Claim flagged for manual review."
      : "Claim pending — quick verification required.",
  });
});

// STATS
app.get("/api/stats", async (_req, res) => {
  const [totalWorkers, activePolicies, allClaims] = await Promise.all([
    Worker.countDocuments(), Policy.countDocuments({ active: true }), Claim.find(),
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

// ADMIN
app.get("/api/admin/workers",  async (_req, res) => res.json(await Worker.find().sort({ registeredAt: -1 }).limit(50)));
app.get("/api/admin/claims",   async (_req, res) => res.json(await Claim.find().populate("workerId","name phone city").sort({ createdAt: -1 }).limit(50)));
app.get("/api/admin/policies", async (_req, res) => res.json(await Policy.find({ active: true }).populate("workerId","name phone city premium").sort({ activatedAt: -1 })));

app.post("/api/admin/run-cron", async (_req, res) => {
  const result = await runWeatherCron();
  res.json({ success: true, result });
});

app.get("/api/admin/cron-status", (_req, res) => res.json({
  lastRun: lastCronRun, schedule: "every 30 minutes", stats: lastCronStats,
  nextRun: lastCronRun ? new Date(new Date(lastCronRun).getTime() + 30 * 60_000).toISOString() : "pending",
}));

app.get("/api/ml/health", async (_req, res) => {
  try {
    const r = await fetch(`${ML_URL}/health`, { signal: AbortSignal.timeout(2000) });
    res.json({ ...await r.json(), ml_url: ML_URL });
  } catch { res.status(503).json({ status: "ml_service_down", ml_url: ML_URL }); }
});

// BOOT
mongoose.connect(MONGO_URI)
  .then(() => console.log(`✅ MongoDB connected → ${MONGO_URI}`))
  .catch(err => console.warn(`⚠️  MongoDB unavailable — ${err.message}\n   Running without persistence`));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🛡  ZeptoShield API  → http://localhost:${PORT}`);
  console.log(`🤖 ML Service       → ${ML_URL}`);
  console.log(`💳 Razorpay mode    → ${RAZORPAY_KEY_ID.startsWith("rzp_test") ? "SANDBOX" : "LIVE"}`);
  console.log(`⏰ Cron schedule    → every 30 minutes (auto-claim trigger)`);
  console.log(`🔑 OTP demo code    → ${DEMO_OTP}`);
  console.log(`🗄  MongoDB         → ${MONGO_URI}\n`);
});
