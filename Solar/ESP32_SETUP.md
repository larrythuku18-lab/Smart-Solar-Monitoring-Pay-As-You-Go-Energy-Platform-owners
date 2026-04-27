# 🔌 ESP32 Solar Panel Integration Guide

Complete setup guide for connecting ESP32 hardware with your solar platform.

---

## 📋 Quick Start Checklist

- [ ] Hardware assembled and wired
- [ ] ESP32 firmware flashed
- [ ] Backend server running
- [ ] First telemetry received
- [ ] Panel validated
- [ ] Monitoring active

---

## 🛠️ Hardware Setup

### Components Needed

| Component | Model | Cost | Purpose |
|-----------|-------|------|---------|
| ESP32 | ESP32-DevKitC | $10 | Main controller |
| Voltage Sensor | ZMPT101B | $3 | Monitor panel voltage |
| Current Sensor | ACS712 (30A) | $5 | Monitor current flow |
| Battery Monitor | Analog voltage divider | $1 | Battery level sensing |
| GSM Module | SIM800L | $15 | Rural connectivity |
| Relay Module | 5V Single Relay | $2 | Power control |
| Wires & Connectors | - | $5 | Connections |
| **Total** | - | **~$41** | Complete setup |

### Wiring Diagram

```
┌─────────────────────────────────────────┐
│           SOLAR PANEL (48V)             │
└──────────────────┬──────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
     [ZMPT101B]          [ACS712-30A]
    Voltage Div.        Current Sensor
        │                     │
        └──────────┬──────────┘
                   │
            ┌──────┴──────┐
            │   ESP32     │
         GPIO35  GPIO34   GPIO32     GPIO4
        Volt In  Curr In  Batt In  Relay Out
            │      │       │        │
            └──────┴───────┴────────┘
                   │
        ┌──────────┴──────────┐
        │    Backend Server   │
        │   (Node.js/REST)    │
        └─────────────────────┘
```

### Pin Configuration in ESP32

```c
#define VOLTAGE_PIN 35      // ADC1_7 - Voltage sensor input
#define CURRENT_PIN 34      // ADC1_6 - Current sensor input
#define BATTERY_PIN 32      // ADC1_4 - Battery level
#define RELAY_PIN 4         // Digital GPIO - Power relay control
#define GSM_RX 16           // SoftSerial RX (SIM800L)
#define GSM_TX 17           // SoftSerial TX (SIM800L)
```

### Voltage Sensor Calibration

For 48V system:
```
Max Panel Voltage: 48V
ADC Reference: 3.3V
Required Divider Ratio: 48/3.3 = 14.5

Example divider:
R1 = 100kΩ
R2 = 7.15kΩ
Ratio = (R1 + R2) / R2 = 107.15 / 7.15 ≈ 15

Adjusted constant: VOLTAGE_CALIBRATION = 15.0
```

### Current Sensor (ACS712-30A) Calibration

```
Sensitivity: 185 mV per A (for 30A version)
Offset Voltage: 2.5V (at 0A current)
Max Current: 30A
Output: 0V (at -30A) to 5V (at +30A)

For 3.3V ADC:
- Readings 0V = -30A
- Readings 1.65V = 0A
- Readings 3.3V = +30A
```

---

## 📱 ESP32 Firmware Installation

### Step 1: Install Arduino IDE
```bash
# Download from https://www.arduino.cc/en/software
# Or use VS Code + PlatformIO
```

### Step 2: Add ESP32 Board Manager

In Arduino IDE:
1. File → Preferences
2. Add board manager URL: `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
3. Tools → Board Manager → Search "esp32" → Install

### Step 3: Upload Firmware

```bash
# Option 1: Arduino IDE
1. Open esp32-firmware.ino
2. Tools → Board → ESP32 Dev Module
3. Tools → Port → Select /dev/ttyUSB0 (Linux/Mac) or COM3 (Windows)
4. Click Upload

# Option 2: Command Line (esptool)
esptool.py --chip esp32 --port /dev/ttyUSB0 \
  --baud 460800 write_flash -z 0x1000 \
  esp32-firmware.bin
```

### Step 3: Configure WiFi & Backend

Edit these lines in `esp32-firmware.ino`:

```cpp
// ===== CONFIGURATION =====
#define BACKEND_URL "http://YOUR_BACKEND.com/api/telemetry"
#define DEVICE_ID "SOLAR_DEVICE_001"
#define PANEL_TYPE "Monocrystalline_400W"

// WiFi Settings (for urban areas)
const char* ssid = "YOUR_SSID";
const char* password = "YOUR_PASSWORD";

// GSM Settings (for rural areas - update SIM800L config)
// const char* apn = "safaricom";  // For Safaricom Kenya
```

### Step 4: Monitor Serial Output

```bash
# Watch firmware logs
screen /dev/ttyUSB0 115200
# or
minicom -D /dev/ttyUSB0 -b 115200
```

Expected output:
```
=== ESP32 Solar Monitor Starting ===
Connecting to WiFi: YOUR_SSID
....................
WiFi connected! IP: 192.168.1.100
Initializing sensors...
Sensors initialized
Setup complete. Starting telemetry...
📊 Telemetry: V=48.0V I=8.20A Gen=393W Bat=78% Eff=75%
✅ HTTP sent successfully
```

---

## 🖥️ Backend Integration

### Step 1: Update Node.js Dependencies

```bash
cd Solar/
npm install
```

New features already integrated:
- ✅ ESP32 telemetry endpoint: `POST /api/telemetry`
- ✅ Panel configuration API
- ✅ Multi-panel support
- ✅ Sensor validation

### Step 2: Start the Server

```bash
npm start
# Server runs on http://localhost:3000
```

### Step 3: Verify Integration

Test telemetry reception:
```bash
curl -X POST http://localhost:3000/api/telemetry \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "SOLAR_DEVICE_001",
    "panelType": "Monocrystalline_400W",
    "voltage": 48.2,
    "current": 8.3,
    "generation": 400,
    "battery": 85,
    "consumption": 300,
    "temperature": 28
  }'
```

Expected response:
```json
{
  "success": true,
  "message": "Telemetry received",
  "validation": {
    "isValid": true,
    "issues": []
  },
  "faults": [],
  "state": { ... }
}
```

---

## 🔧 API Endpoints

### Solar Panel Configuration

#### Get Available Panels
```bash
GET /api/panels/catalog
```

Response:
```json
{
  "success": true,
  "panels": [
    {
      "id": "Monocrystalline_400W",
      "type": "Monocrystalline",
      "nominalPower": 400,
      "maxVoltage": 48,
      "maxCurrent": 8.3,
      "efficiency": 0.21,
      "description": "Premium efficiency panel..."
    },
    ...
  ]
}
```

#### Get Current Panel Configuration
```bash
GET /api/panels/config
```

#### Configure Panel Type
```bash
POST /api/panels/configure
Content-Type: application/json

{
  "panelType": "Bifacial_450W"
}
```

#### Setup Multiple Panels
```bash
POST /api/panels/multi-setup
Content-Type: application/json

{
  "panels": [
    { "type": "Monocrystalline_400W", "quantity": 2 },
    { "type": "Half_Cell_380W", "quantity": 1 }
  ],
  "configuration": "series"
}
```

### Telemetry & Validation

#### Send Telemetry
```bash
POST /api/telemetry
Content-Type: application/json

{
  "deviceId": "SOLAR_DEVICE_001",
  "panelType": "Monocrystalline_400W",
  "voltage": 48.2,
  "current": 8.3,
  "generation": 400,
  "battery": 85,
  "consumption": 300,
  "temperature": 28
}
```

#### Validate Readings
```bash
POST /api/panels/validate
Content-Type: application/json

{
  "voltage": 48.2,
  "current": 8.3,
  "temperature": 28
}
```

Response shows:
- ✅ Valid/Invalid status
- ⚠️ Issues detected
- 🌡️ Temperature effects
- 💡 Efficiency impact

#### Get Maintenance Schedule
```bash
GET /api/panels/maintenance
```

---

## 🌡️ Temperature Considerations

### Panel Temperature Effects

Temperature coefficients vary by panel type:

| Panel Type | Coefficient | Effect at 50°C |
|-----------|-------------|----------------|
| Monocrystalline | -0.004/°C | 90% of rated power |
| Polycrystalline | -0.005/°C | 87% of rated power |
| Thin-Film | -0.002/°C | 95% of rated power |
| Bifacial | -0.003/°C | 92% of rated power |

To get estimated power at different temperatures:
```
Adjusted_Power = Nominal_Power × (1 + Coefficient × (Temperature - 25°C))
```

Example (Monocrystalline 400W at 50°C):
```
400 × (1 + (-0.004) × (50 - 25)) = 400 × 0.9 = 360W
```

---

## 📊 Monitoring Dashboard Features

### Real-Time Metrics
- Voltage, Current, Power (Watts)
- Battery Level %
- Efficiency ratio
- Connection status (WiFi/GSM)

### AI-Powered Insights
- **Energy Forecasting**: Next 6 hours prediction
- **Predictive Maintenance**: Fault detection
- **Fraud Detection**: Payment anomalies
- **Usage Optimization**: Load-shift recommendations

### Fault Detection

Automatically detects:
- 🔌 **Panel Dust**: Power loss >40%
- ⚠️ **Wiring Issues**: Voltage drops
- 🌤️ **Shading**: Power <30% of nominal
- 🔥 **Degradation**: Power <50% nominal

---

## 🐛 Troubleshooting

### Issue: ESP32 not connecting to WiFi

**Solution:**
```cpp
// Check WiFi credentials
Serial.println(WiFi.SSID());

// Enable verbose logging
WiFi.onEvent(WiFiEvent);

void WiFiEvent(WiFiEvent_t event) {
  Serial.printf("WiFi Event: %d\n", event);
}
```

### Issue: Voltage readings wrong

**Solution:**
1. Measure actual voltage at ADC pin with multimeter
2. Calculate new calibration: `VOLTAGE_CALIBRATION = (measured_panel_voltage / adc_voltage)`
3. Update in firmware

### Issue: Current sensor showing negative values

**Solution:**
```cpp
// Check ACS712 orientation (polarity matters)
// Red wire = positive current direction
// Check offset: should read ~2.5V at 0A

float adcVoltage = (rawValue / 4095.0) * 3.3;
Serial.printf("ADC Voltage: %.2fV (should be ~2.5V at zero current)\n", adcVoltage);
```

### Issue: Telemetry not reaching backend

**Solution:**
```cpp
// Test connectivity
if (WiFi.status() == WL_CONNECTED) {
  Serial.println("WiFi: Connected");
} else {
  Serial.println("WiFi: Disconnected - checking GSM...");
}

// Test backend URL
// Make sure BACKEND_URL is correct and reachable
curl http://your-backend.com/api/telemetry
```

---

## 📈 Performance Optimization

### Reduce Power Consumption
```cpp
// Increase telemetry interval (lower frequency)
#define UPDATE_INTERVAL 10000  // 10 seconds instead of 5

// Enable WiFi sleep mode
WiFi.setSleep(true);

// Use deep sleep between measurements (for battery devices)
esp_deep_sleep_start();
```

### Improve Accuracy
```cpp
// Increase ADC sampling
const int SAMPLE_COUNT = 10;
float readVoltageAveraged() {
  float sum = 0;
  for (int i = 0; i < SAMPLE_COUNT; i++) {
    sum += readVoltage();
  }
  return sum / SAMPLE_COUNT;
}
```

### Handle Network Failures
```cpp
// Automatic fallback WiFi → GSM
if (WiFi.status() != WL_CONNECTED) {
  Serial.println("WiFi down, switching to GSM...");
  initializeGSM();
  sendViaGSM(payload);
}
```

---

## 📱 Mobile Integration

### Android App Integration
```javascript
// Fetch panel status in React Native/Flutter
const response = await fetch('http://backend/api/panels/config');
const config = await response.json();

// Display panel health
console.log(`Panel: ${config.panelHealth.efficiency}`);
console.log(`Faults: ${config.detectedFaults.length}`);
```

### Web Dashboard
```javascript
// Real-time updates with WebSocket
const ws = new WebSocket('ws://localhost:3000/ws');
ws.onmessage = (event) => {
  const telemetry = JSON.parse(event.data);
  updateDashboard(telemetry);
};
```

---

## 🎯 Next Steps

1. ✅ Flash ESP32 firmware
2. ✅ Connect to WiFi/GSM
3. ✅ Verify telemetry in backend
4. ✅ Configure correct panel type
5. ✅ Monitor dashboard
6. ✅ Set up maintenance alerts
7. ✅ Integrate with mobile app

---

## 📚 Reference

- [ESP32 Documentation](https://docs.espressif.com/projects/esp-idf/en/latest/)
- [ACS712 Datasheet](https://www.allegromicro.com/en/products/sense/current-sensor-ics/zero-to-fifty-amp-integrated-conductor-sensed-acs-series)
- [Backend API Docs](./DEPLOYMENT.md)
- [AI Integration Guide](./AI_INTEGRATION.md)

---

**Questions?** Check the dashboard logs or run diagnostics:
```bash
curl http://localhost:3000/api/state
curl http://localhost:3000/api/panels/config
curl http://localhost:3000/api/panels/maintenance
```
