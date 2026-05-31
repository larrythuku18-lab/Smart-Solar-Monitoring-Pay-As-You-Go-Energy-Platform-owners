# Smart Solar Monitoring & Pay-As-You-Go Energy Platform

A solar energy pay-as-you-go system with AI-powered insights, SQLite persistence, M-Pesa payments, and ESP32 relay control.

## Features

- **Real-time dashboard** — energy generation, battery, consumption, weather impact
- **AI services** — forecasting, predictive maintenance, fraud detection, usage optimization
- **SQLite database** — persistent storage via `better-sqlite3` (zero-config)
- **M-Pesa STK Push** — Daraja API integration with sandbox simulation fallback
- **JWT authentication** — device ID + PIN login for protected routes
- **Relay control** — HTTP commands to ESP32 with retry queue
- **Scheduled jobs** — wallet expiry checks every 15 minutes, relay retry every 5 minutes

## Project Structure

```
├── server.js           # Express API server (entry point)
├── db.js               # SQLite schema, seed data, query helpers
├── relay.js            # ESP32 relay lock/unlock with retry queue
├── authMiddleware.js   # JWT verification middleware
├── ai-models.js        # 4 AI services with safe fallbacks
├── index.html          # Admin dashboard UI
├── index.js            # Frontend (dynamic API_BASE)
├── package.json
├── .env.example
└── solarpayg.db        # Created automatically on first run
```

## Getting Started

### Prerequisites

- Node.js 18+

### Installation

```bash
# Clone and enter the project
git clone <repository-url>
cd Smart-Solar-Monitoring-Pay-As-You-Go-Energy-Platform

# Install dependencies
npm install

# Configure environment (optional — works in simulation mode without M-Pesa keys)
cp .env.example .env
# Edit .env with your M-Pesa credentials and JWT secret

# Start the server
npm start
```

### Access

| Resource | URL |
|----------|-----|
| Dashboard | http://localhost:3000/index.html |
| Health check | http://localhost:3000/health |
| API state | http://localhost:3000/api/state |

### Demo credentials

| Field | Value |
|-------|-------|
| Device ID | `DEMO-001` |
| PIN | `1234` |

Login via `POST /api/auth/login` with `{ "deviceId": "DEMO-001", "pin": "1234" }` to get a JWT for protected routes.

### Development

```bash
npm run dev   # nodemon with auto-restart
```

## API Endpoints

### Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/state` | Current system state |
| GET | `/api/forecast` | 6-hour energy forecast |
| GET | `/api/maintenance-alerts` | Hardware anomaly alerts |
| GET | `/api/optimization` | Usage recommendations |
| GET | `/api/weather` | Weather + solar impact |
| POST | `/api/auth/login` | Login with deviceId + pin |

### Protected (Bearer JWT required)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/pay` | Initiate M-Pesa STK Push |
| POST | `/api/fraud-check` | Fraud detection (validated input) |
| GET | `/api/admin/summary` | Admin dashboard stats |

### M-Pesa

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/mpesa/callback` | Safaricom payment callback |

## Environment Variables

See [`.env.example`](.env.example):

```
PORT=3000
MPESA_CONSUMER_KEY=your_key_here
MPESA_CONSUMER_SECRET=your_secret_here
MPESA_SHORTCODE=174379
MPESA_PASSKEY=your_passkey_here
MPESA_CALLBACK_URL=https://yourdomain.com/api/mpesa/callback
JWT_SECRET=change_this_to_a_random_string
```

If M-Pesa credentials are missing, payments run in **simulation mode** (auto-confirms after 3 seconds).

## ESP32 Relay

Configure the device IP in the database (`devices.device_ip`). The relay module sends:

```
POST http://<device_ip>/relay
{ "state": "on" | "off" }
```

Failed commands are queued in `pending_commands` and retried every 5 minutes.

## License

MIT
