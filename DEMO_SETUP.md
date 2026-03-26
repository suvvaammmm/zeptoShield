# ZeptoShield — Demo Day Setup Guide

## What's new in this build

| Feature | File | Status |
|---------|------|--------|
| **node-cron auto-trigger** | `backend/server.js` | ✅ Every 30 min, auto-claims on threshold |
| **Razorpay sandbox** | `backend/server.js` | ✅ Premium payment + UPI payout |
| **MongoDB persistence** | `backend/server.js` | ✅ All data survives restarts |
| **OTP authentication** | `frontend/pages/login.html` | ✅ Demo OTP: `1234` |
| **Admin dashboard** | `frontend/pages/admin.html` | ✅ Stats, claims, workers, cron control |

---

## Day 1 Setup (30 min)

### 1. Install new dependencies
```bash
cd backend
npm install mongoose node-cron razorpay
```

### 2. Start MongoDB
```bash
# macOS/Linux
mongod --dbpath /tmp/zeptoshield-db

# Or use MongoDB Atlas (free tier) — update MONGO_URI in .env
```

### 3. Add your Razorpay sandbox keys
```bash
cp .env.example .env
# Edit .env with your keys from dashboard.razorpay.com → Test mode
```

### 4. Start server
```bash
npm run dev
# You should see:
# ✅ MongoDB connected
# 💳 Razorpay mode → SANDBOX
# ⏰ Cron schedule → every 30 minutes
```

---

## Razorpay Sandbox Setup (15 min)

1. Sign up at [dashboard.razorpay.com](https://dashboard.razorpay.com)
2. Go to **Settings → API Keys → Generate Test Key**
3. Copy `Key ID` and `Key Secret` into `.env`
4. For payouts: enable **Route** in your sandbox dashboard

### Demo payment flow
- Worker registers → clicks "Pay ₹30 premium"
- Razorpay checkout opens (use test card: `4111 1111 1111 1111`, any CVV/expiry)
- Payment confirmed → policy activates
- When claim fires → `₹1500` payout queued to worker's UPI

---

## Cron Job Explained

```
Every 30 min:
  1. Find all active policies
  2. Group workers by city
  3. Fetch live weather (Open-Meteo) for each city
  4. Check thresholds:
     - Rain ≥ 40mm → trigger rain claim
     - Temp ≥ 42°C → trigger heat claim
     - AQI ≥ 350   → trigger AQI claim
  5. Create approved claim + initiate Razorpay payout
```

### Manual trigger (for demo)
```bash
curl -X POST http://localhost:5000/api/admin/run-cron
```
Or click **▶ Run cron now** in the Admin dashboard.

---

## OTP Login (Demo Mode)

- URL: `frontend/pages/login.html`
- Enter any 10-digit phone → click Send OTP
- **Always use `1234`** as the OTP
- Auto-redirects to dashboard if worker exists, or register if new

---

## Admin Dashboard

- URL: `frontend/pages/admin.html`
- Shows: workers, active policies, claims today, flagged claims, total payout
- Live cron status (last run, next run, cities checked, claims triggered)
- **Run cron manually** for demo — shows live results in an alert
- Auto-refreshes every 60 seconds

---

## New API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/send-otp` | Send OTP (demo: always 1234) |
| POST | `/api/auth/verify-otp` | Verify OTP |
| POST | `/api/payments/create-order` | Create Razorpay premium order |
| POST | `/api/payments/verify` | Verify payment + activate policy |
| POST | `/api/workers/:phone/upi` | Save UPI for payouts |
| GET  | `/api/admin/workers` | All workers |
| GET  | `/api/admin/claims` | All claims (with worker info) |
| GET  | `/api/admin/policies` | Active policies |
| POST | `/api/admin/run-cron` | Manually trigger cron |
| GET  | `/api/admin/cron-status` | Cron last run / next run stats |

---

## Demo Script (5 min flow)

1. **Open Admin dashboard** → show 0 workers, explain cron is running
2. **Register a worker** (register.html) → Hyderabad, ₹6000/week
3. **Pay premium** → Razorpay checkout, test card, policy activates
4. **Admin dashboard** → now shows 1 worker, 1 active policy
5. **Click "Run cron now"** → shows weather check, claim triggered (if threshold met)
6. **Claims table** shows auto-triggered claim with ₹1500 payout
7. **Login flow** (login.html) → phone + OTP 1234 → dashboard

**Verbal:** *"This whole flow — detect disaster, verify identity, disburse payment — happens automatically every 30 minutes without any human intervention."*
