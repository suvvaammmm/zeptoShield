# ZeptoShield v2 — Setup Guide

## What changed in this version

| Feature | Before | Now |
|---|---|---|
| OTP | Hardcoded `1234` always | Real Twilio SMS, falls back to `1234` in dev |
| Auth | `sessionStorage` only, no server token | Server-issued JWT-style token, 24h TTL |
| Database | In-memory (resets on restart) | MongoDB with full persistence |
| Live updates | Manual refresh / alerts | WebSocket push — all pages update in real time |
| Register | No auth check | Must verify phone via OTP before registering |
| Admin | No protection | Token-based guard, admin phone list |

---

## Step 1 — Install dependencies

```bash
cd backend
npm install
```

This installs: `express`, `mongoose`, `cors`, `node-cron`, `razorpay`, **`ws`** (WebSocket), **`twilio`**, `nodemon`.

---

## Step 2 — Set up MongoDB

**Option A — Local (easiest for demo)**
```bash
# macOS
brew install mongodb-community && brew services start mongodb-community

# Ubuntu
sudo systemctl start mongod
```

**Option B — MongoDB Atlas (free cloud)**
1. Go to https://cloud.mongodb.com → Create free cluster
2. Get your connection string: `mongodb+srv://user:pass@cluster.mongodb.net/zeptoshield`

---

## Step 3 — Configure Twilio (real OTP)

1. Sign up at https://twilio.com (free trial gives you $15 credit)
2. Dashboard → **Verify** → Create a new Verify Service
3. Copy: Account SID, Auth Token, Verify Service SID (starts with `VA...`)

**Without Twilio** the server still works in demo mode — OTP is always `1234` and logged to console.

---

## Step 4 — Create `.env` file

```bash
cp .env.example .env
```

Edit `.env`:

```env
MONGO_URI=mongodb://localhost:27017/zeptoshield

# Razorpay sandbox
RAZORPAY_KEY_ID=rzp_test_YOUR_KEY
RAZORPAY_KEY_SECRET=YOUR_SECRET

# Twilio (leave blank for demo mode)
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_VERIFY_SID=VAxxxxxxxx

# Your phone number gets admin access after OTP login
ADMIN_PHONES=9876543210

PORT=5000
NODE_ENV=development
```

---

## Step 5 — Start the server

```bash
npm run dev
# or
node server.js
```

You'll see:
```
✅ MongoDB connected → mongodb://localhost:27017/zeptoshield
🛡  ZeptoShield API     → http://localhost:5000
🔌 WebSocket           → ws://localhost:5000
📱 OTP mode            → Twilio Verify (real SMS)   ← or Demo (code: 1234)
⏰ Cron schedule        → every 30 minutes
```

---

## Step 6 — Open the frontend

Open `frontend/pages/login.html` in your browser directly, or serve with:

```bash
npx serve frontend -l 3000
# then open http://localhost:3000/pages/login.html
```

---

## How the real-time flow works

```
Worker registers / claim fires / cron runs
            ↓
    Backend emits WebSocket event
            ↓
All open browser tabs receive it instantly
            ↓
Admin dashboard: new row highlights green
Worker dashboard: toast notification appears
No page refresh needed
```

## WebSocket event types

| Event | Who sees it |
|---|---|
| `admin_new_worker` | Admin dashboard — new row in workers table |
| `admin_new_claim` | Admin dashboard — new row in claims table |
| `admin_policy_activated` | Admin dashboard — KPI bumps |
| `claim_auto_triggered` | Worker's own dashboard — toast + claim row |
| `claim_result` | Worker's own dashboard — result of manual trigger |
| `policy_activated` | Worker's own dashboard |
| `cron_started` | Admin live bar |
| `cron_complete` | Admin live bar + stats update |
| `weather_update` | (all) — city weather data |

---

## API changes (v1 → v2)

All protected routes now require:
```
Authorization: Bearer <token>
```

Token is returned from `POST /api/auth/verify-otp` and should be stored in `localStorage`.

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/auth/send-otp` | None | Twilio or demo |
| `POST /api/auth/verify-otp` | None | Returns token |
| `GET /api/auth/me` | Token | Session check |
| `POST /api/auth/logout` | Token | Deletes session |
| `POST /api/workers/register` | Token | Phone from token |
| `GET /api/workers/me` | Token | Own profile |
| `POST /api/claims/trigger` | Token | Own claims only |
| `GET /api/admin/*` | Token + isAdmin | Admin only |

---

## Demo flow for hackathon

1. Open `login.html` → enter your phone → OTP arrives (real SMS) or use `1234`
2. If first time: redirect to `register.html` → fill form → account created
3. Dashboard shows live weather + policy status
4. Admin: log in as admin phone → admin dashboard with WebSocket live feed
5. Run cron from admin page → see claims fire in real time on both screens
