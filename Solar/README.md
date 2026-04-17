# Smart Solar Monitoring & Pay-As-You-Go Energy Platform

A prototype dashboard and backend simulator for a solar energy pay-as-you-go system designed for rural and off-grid communities.

## Component Breakdown

### 🟢 A. IoT Layer (Hardware)
- Microcontroller: ESP32 (cheap + powerful)
- Sensors:
  - Voltage sensor
  - Current sensor
  - Battery level monitor

**Role:**
- Collect energy data
- Send data to cloud every few seconds/minutes

### 🔵 B. Communication Layer
- GSM (SIM800L) → works in rural areas
- WiFi (optional for urban homes)

**Why this matters:**
- Internet is unreliable → GSM ensures coverage.

### 🟣 C. Backend (Brain of the system)
- Build using Node.js / Python (FastAPI)
- Hosted on cloud (AWS / Render / Firebase)

**Responsibilities:**
- Receive IoT data
- Store usage data
- Calculate billing
- Trigger power cut if unpaid

### 🟡 D. Payment Integration (CRITICAL)
- Integrate with Safaricom M-Pesa API

**Features:**
- STK Push (user pays via phone)
- Auto verification of payments
- Wallet system per user

### 🔴 E. Control System (Power Lock/Unlock)
- Relay module connected to IoT device

**Logic:**
- If payment expires → cut power
- If user pays → restore power

### ⚪ F. User Interface
1. Mobile App (Android first)
   - Battery status
   - Energy usage
   - Payment button
   - Alerts
2. Web Dashboard (for admin)
   - Monitor all users
   - Revenue tracking
   - Device control

### 🟤 G. Database Design (Simple MVP)
- Users
- Devices
- Energy_Usage
- Payments
- Alerts

## 🔐 Security
- Encrypt device communication
- Authenticate devices with tokens
- Prevent bypass of relay system

## ⚡ MVP Roadmap
- Phase 1 (2–4 weeks): Build IoT device (basic sensor + ESP32); send data to server
- Phase 2 (2–3 weeks): Build backend API; store and visualize energy data
- Phase 3 (2–3 weeks): Integrate M-Pesa payments; add simple payment logic
- Phase 4 (2 weeks): Add relay control (cut/restore power)
- Phase 5: Build mobile app UI

## 🌍 Why this can win in Africa
- Works with existing mobile money culture
- Solves real problem (affordability + monitoring)
- Can partner with solar companies

## Getting Started
1. Install dependencies: `npm install`
2. Run the simulator: `npm start`
3. Open `http://localhost:3000`

## Project Files
- `index.html` — dashboard UI
- `index.js` — frontend application logic
- `server.js` — backend API simulator
- `package.json` — Node.js package manifest

## Architecture Diagram

[ Solar Panels ]
        ↓
[ Charge Controller ]
        ↓
[ Smart IoT Meter Device ]
   (ESP32 / Arduino + Sensors)
        ↓
   (GSM / WiFi)
        ↓
[ Cloud Backend Server ]
        ↓
 ┌───────────────┬───────────────┬───────────────┐
 │               │               │               │
[ Database ] [ Payment API ] [ Notification Service ]
                  ↓
            (M-Pesa API)
                  ↓
         Customer Payments
                  ↓
[ Mobile/Web Dashboard ]
