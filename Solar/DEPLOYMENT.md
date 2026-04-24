# 🚀 AI Deployment Guide - Solar Pay-As-You-Go

Quick start guide for deploying the AI-enhanced solar platform to production.

---

## ⚡ Quick Start (Local Testing)

```bash
# 1. Install dependencies
npm install

# 2. Run the server
npm start

# 3. Open dashboard
open http://localhost:3000

# 4. Test AI endpoints
curl http://localhost:3000/api/forecast
curl http://localhost:3000/api/maintenance-alerts
curl http://localhost:3000/api/optimization
```

---

## 📦 Deployment Targets

### Option A: Render.com (Recommended - Free Tier Available)

**Steps:**
1. Push code to GitHub
2. Connect Render to repo
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Deploy ✅

**No changes needed** - AI runs in-memory.

**Cost:** Free tier (512MB RAM) → $7/month

### Option B: Railway.app

```bash
# 1. Install Railway CLI
npm install -g @railway/cli

# 2. Login and initialize project
railway login
railway init

# 3. Set start command
railway add -e "start=node server.js"

# 4. Deploy
railway up
```

**Cost:** $5/month minimum

### Option C: AWS Lambda + DynamoDB

**Advanced setup** - Stores data persistently:

```javascript
// lambda-handler.js
import { forecaster, maintenanceMonitor } from './ai-models.js';
import AWS from 'aws-sdk';

const dynamodb = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
  const { deviceId, generation, consumption, voltage, current } = JSON.parse(event.body);
  
  // Run AI predictions
  forecaster.addDataPoint(generation, consumption, Date.now());
  const forecast = forecaster.forecast(6);
  
  // Store in DynamoDB
  await dynamodb.put({
    TableName: 'solar-forecasts',
    Item: {
      deviceId,
      timestamp: Date.now(),
      forecast,
      ttl: Math.floor(Date.now() / 1000) + 86400 // 24 hour expiry
    }
  }).promise();
  
  return {
    statusCode: 200,
    body: JSON.stringify({ forecast })
  };
};
```

**Cost:** $0 for free tier (1M requests/month)

### Option D: Azure App Service

```bash
# 1. Create resource group
az group create --name solar-ai-rg --location eastus

# 2. Create App Service plan
az appservice plan create --name solar-ai-plan --resource-group solar-ai-rg --sku F1

# 3. Deploy app
az webapp up --resource-group solar-ai-rg --name solar-ai-app
```

**Cost:** Free tier (1 GB RAM)

---

## 🔧 Configuration for Production

### Environment Variables

Create `.env` file:
```bash
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Optional: Database
DATABASE_URL=postgresql://user:pass@localhost:5432/solar_db

# Optional: Redis cache
REDIS_URL=redis://localhost:6379

# Optional: Monitoring
SENTRY_DSN=https://xxxxx@sentry.io/xxxxx
```

### Performance Tuning

```javascript
// server.js
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

if (cluster.isMaster && process.env.NODE_ENV === 'production') {
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
} else {
  app.listen(port);
}
```

### Database Integration (Optional)

**PostgreSQL for historical data:**

```javascript
// ai-models.js with database backup
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function persistHistoricalData() {
  await pool.query(
    `INSERT INTO energy_history (device_id, generation, consumption, voltage, current, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [deviceId, generation, consumption, voltage, current, Date.now()]
  );
}

// Persist every 10 data points
if (historyData.timestamps.length % 10 === 0) {
  await persistHistoricalData();
}
```

---

## 🔄 CI/CD Pipeline

### GitHub Actions

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Render

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      
      - name: Run tests
        run: npm test
      
      - name: Deploy
        run: |
          curl -X POST ${{ secrets.RENDER_DEPLOY_HOOK }}
```

### Pre-deployment Checks

```bash
#!/bin/bash
# test-ai.sh - Run before deploy

echo "Testing AI endpoints..."

# Start server in background
node server.js &
SERVER_PID=$!
sleep 2

# Test endpoints
curl -f http://localhost:3000/api/forecast || exit 1
curl -f http://localhost:3000/api/maintenance-alerts || exit 1
curl -f http://localhost:3000/api/optimization || exit 1

kill $SERVER_PID
echo "✅ All AI endpoints working"
```

---

## 📊 Monitoring & Logging

### Key Metrics to Track

```javascript
// monitoring.js
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

// Track forecast accuracy
logger.info({
  forecast: 'Energy forecast generated',
  hour: 1,
  predicted: 220,
  actual: 225,
  error: 0.02
});

// Track maintenance alerts
logger.warn({
  alert: 'Voltage anomaly detected',
  severity: 'high',
  voltage: 58,
  timestamp: Date.now()
});

// Track fraud flags
logger.error({
  fraud: 'Suspicious payment pattern',
  userId: 'user_123',
  amount: 5000,
  action: 'auto_lock_relay'
});
```

### Sentry Error Tracking

```javascript
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 1.0
});

try {
  forecaster.trainModel();
} catch (error) {
  Sentry.captureException(error);
}
```

---

## 🧪 Testing AI Features

### Unit Tests

```javascript
// tests/ai-models.test.js
import { EnergyForecaster, FraudDetector } from '../ai-models.js';

describe('EnergyForecaster', () => {
  it('should forecast 6 hours ahead', () => {
    const forecaster = new EnergyForecaster();
    
    // Add 100 data points
    for (let i = 0; i < 100; i++) {
      forecaster.addDataPoint(200 + Math.random() * 50, 130, Date.now());
    }
    
    const forecast = forecaster.forecast(6);
    expect(forecast).toHaveLength(6);
    expect(forecast[0].predictedGeneration).toBeGreaterThan(0);
  });
});

describe('FraudDetector', () => {
  it('should flag rapid-fire payments', () => {
    const detector = new FraudDetector();
    
    // Simulate 3 payments in 5 minutes
    const now = Date.now();
    detector.recordPayment('user_1', 'device_1', 100, now);
    detector.recordPayment('user_1', 'device_1', 100, now + 60000);
    const fraud = detector.recordPayment('user_1', 'device_1', 100, now + 120000);
    
    expect(fraud).not.toBeNull();
    expect(fraud.type).toBe('rapid_fire_payments');
  });
});
```

Run tests:
```bash
npm test
```

---

## 🌐 Multi-Region Deployment

### Deploy to 3 Regions (Failover)

```bash
# Region 1: East Africa (Kenya)
az app service create --name solar-ai-ea --location eastafrica

# Region 2: Central Africa (Nigeria)
az app service create --name solar-ai-ca --location centralafrika

# Region 3: Backup (South Africa)
az app service create --name solar-ai-za --location southafrica

# Route traffic with Azure Traffic Manager
az network traffic-manager endpoint create \
  --name solar-ai-ea \
  --profile-name solar-ai-tm \
  --type azureEndpoints \
  --target solar-ai-ea.azurewebsites.net
```

---

## 💰 Cost Optimization

### Reduce Costs to $5/month

1. **Reduce historical window** (24h → 12h)
   ```javascript
   const MAX_HISTORY = 144; // 12 hours instead of 24
   ```

2. **Cache predictions** (5s intervals → 15s)
   ```javascript
   const FORECAST_CACHE_TTL = 15000; // 15 seconds
   ```

3. **Archive old data** (keep only 7 days)
   ```javascript
   if (historyData.timestamps[0] < Date.now() - 7 * 86400000) {
     historyData.generation.shift();
   }
   ```

4. **Use free tier Render.com** ($0/month)

### Scalability Tiers

| Users | Monthly Cost | Infrastructure |
|-------|-------------|-----------------|
| <1K | $0 | Render free tier |
| 1K-10K | $15/mo | Railway.app + Postgres |
| 10K-100K | $100/mo | AWS Lambda + DynamoDB |
| >100K | $500+/mo | Multi-region + CDN |

---

## 🔒 Security Checklist

- [ ] API keys stored in environment variables
- [ ] HTTPS enabled (all platforms default to HTTPS)
- [ ] Rate limiting on `/api/fraud-check` endpoint (100 req/min)
- [ ] No hardcoded device credentials
- [ ] Log rotation configured (30 days max)
- [ ] Database encryption at rest
- [ ] CORS restricted to trusted domains

```javascript
// security.js
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

app.use(helmet()); // Add security headers

const fraudLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: 'Too many fraud checks, please try later'
});

app.post('/api/fraud-check', fraudLimiter, (req, res) => {
  // Handle fraud check
});
```

---

## 📞 Troubleshooting

| Issue | Solution |
|-------|----------|
| **Forecast not improving** | Need 48 hours of data to train |
| **High CPU usage** | Increase `telemetry update interval` to 10s |
| **Memory leaks** | Check that `historyData` is capped at MAX_HISTORY |
| **Alerts not triggering** | Verify voltage/current sensors return valid values |
| **Fraud detection false positives** | Adjust thresholds in `detectFraudPattern()` |

---

## ✅ Verification Checklist

```bash
# 1. Check endpoints are responding
curl http://localhost:3000/api/state
curl http://localhost:3000/api/forecast
curl http://localhost:3000/api/maintenance-alerts

# 2. Verify AI is learning
# (Wait 10 seconds, then check forecast changes)

# 3. Test fraud detection
curl -X POST http://localhost:3000/api/fraud-check \
  -H "Content-Type: application/json" \
  -d '{"userId":"user_1","deviceId":"device_1","amount":100}'

# 4. Monitor logs
tail -f logs/app.log

# 5. Check performance
# (Should respond in <100ms)
```

---

## 🎓 Next Steps

1. **Deploy to Render.com** (5 minutes)
2. **Add database** (PostgreSQL for persistence)
3. **Set up monitoring** (Sentry for error tracking)
4. **Scale to 100+ devices** (add Redis caching)
5. **Implement edge AI** (TensorFlow Lite on ESP32)

Good luck! 🚀☀️
