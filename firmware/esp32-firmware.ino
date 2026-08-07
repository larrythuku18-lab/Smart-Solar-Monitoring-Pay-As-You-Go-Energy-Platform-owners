/**
 * ============================================================
 * ESP32 Solar Panel Monitoring Firmware
 * Smart Solar Pay-As-You-Go Platform
 * ============================================================
 * 
 * Hardware Requirements:
 * - ESP32 Development Board
 * - ACS712 Current Sensor (30A version)
 * - Voltage Divider (48V -> 3.3V ADC)
 * - SIM800L GSM Module (for rural areas)
 * - WiFi (optional, for urban areas)
 * 
 * PIN CONFIGURATION:
 * - GPIO35 (ADC1_7): Voltage Input
 * - GPIO34 (ADC1_6): Current Input  
 * - GPIO32 (ADC1_4): Battery Level
 * - GPIO16: SIM800L RX
 * - GPIO17: SIM800L TX
 * - GPIO4:  Relay Control (power cut)
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>          // OTA partition flashing (only used when OTA_ENABLED=1)
#include <mbedtls/md.h>      // SHA-256 digest while streaming the download

// ===== CONFIGURATION =====
#define BACKEND_URL "https://smart-solar-monitoring-pay-as-you-go.onrender.com/api/telemetry"
// Without this, anyone can POST fake telemetry for any deviceId.
// Preferred: provision this specific DEVICE_ID via POST /api/admin/devices
// (admin-only) and flash the key it returns here — that ties this exact unit
// to its own key, so a leaked key only affects one device and can be
// rotated via POST /api/admin/devices/:deviceId/rotate-key without
// re-flashing the rest of the fleet.
// Fallback below is the shared DEVICE_API_KEY env var, used for any device
// that hasn't been individually provisioned yet — fine to start with, but
// migrate real deployed units to their own key when you can.
// 🔴 SECURITY WARNING — DO NOT HARDCODE A LIVE API KEY HERE.
// The key below must remain EMPTY in source control. Instead:
//   1. Admin provisions each device via POST /api/admin/devices (admin-only)
//      and gets a unique per-device key.
//   2. Flash that unique key into THIS device's firmware.
//
// A shared DEVICE_API_KEY fallback can be set via the server env var as a
// convenience during development, but migrate every real unit to its own
// per-device key before field deployment.
#define DEVICE_API_KEY ""
#define DEVICE_ID "SOLAR_DEVICE_001"  // Give each physical device a unique ID before flashing
#define PANEL_TYPE "Monocrystalline_400W"  // Panel configuration
#define UPDATE_INTERVAL 5000  // Send data every 5 seconds

// ===== OTA UPDATE CONFIGURATION (compile-time opt-in, default OFF) =====
// The backend only serves /api/firmware/* when its OTA_ENABLED env flag is
// true. On the device side this is a *compile-time* switch: set to 1 only on
// a build you intend to self-update. Stock firmware keeps it 0, so nothing
// in the field changes behavior until a deliberately OTA-enabled build is
// flashed — the safe default for a fleet you can't remotely recover.
#define OTA_ENABLED 0

// Version of THIS firmware build. The backend compares against it and only
// offers an update when the published version is strictly newer.
#define FIRMWARE_VERSION "1.0.0"

// Origin of the OTA API (same host as BACKEND_URL). Unused while OTA_ENABLED=0.
#define OTA_SERVER_BASE "https://smart-solar-monitoring-pay-as-you-go.onrender.com"

// Local safety cutoff: power is forced off below this battery % regardless
// of what the backend says, to protect the battery from over-discharge.
#define CRITICAL_BATTERY_PCT 10

// Sensor Pin Definitions
#define VOLTAGE_PIN 35      // ADC1_7 - Voltage sensor
#define CURRENT_PIN 34      // ADC1_6 - Current sensor
#define BATTERY_PIN 32      // ADC1_4 - Battery level
#define RELAY_PIN 4         // Digital - Power relay control

// GSM module on ESP32's UART2 hardware serial (no extra library needed —
// the classic Arduino SoftwareSerial library doesn't compile on ESP32)
HardwareSerial gsmSerial(2);  // RX=16, TX=17 (set in initializeGSM)

// ===== CALIBRATION CONSTANTS =====
// Voltage sensor: 48V max -> 3.3V ADC (divider ratio = 48/3.3 ≈ 14.5)
#define VOLTAGE_CALIBRATION 14.5
#define VOLTAGE_ADC_OFFSET 0

// Current sensor: ACS712-30A (185mV per A, 2.5V offset for 0A)
#define CURRENT_SENSITIVITY 0.185  // volts per amp
#define CURRENT_OFFSET 2.5          // voltage at 0A
#define CURRENT_ADC_REF 3300        // ADC reference voltage (mV)

// ===== GLOBAL VARIABLES =====
unsigned long lastSendTime = 0;
int failureCount = 0;
const int MAX_RETRIES = 3;
String backendRelayState = "on";  // Last relay state the backend told us to apply
bool gsmReady = false;  // Set true once initializeGSM() completes — used instead of
                        // gsmSerial.available(), which only reflects unread serial
                        // bytes right now, not whether the module is actually usable.
unsigned long lastWifiRetry = 0;
const unsigned long WIFI_RETRY_INTERVAL = 30000;  // try a reconnect at most every 30 s

#if OTA_ENABLED
unsigned long lastOtaCheck = 0;
const unsigned long OTA_CHECK_INTERVAL = 86400000UL;  // 24 h
#endif

// Panel configuration database
struct PanelConfig {
  const char* name;
  float maxVoltage;
  float maxCurrent;
  int nominalPower;
};

PanelConfig panelConfigs[] = {
  {"Monocrystalline_400W", 48.0, 8.3, 400},
  {"Polycrystalline_300W", 48.0, 6.2, 300},
  {"Thin_Film_250W", 48.0, 5.2, 250},
  {"Bifacial_450W", 48.0, 9.4, 450},
  {"Half_Cell_380W", 48.0, 7.9, 380}
};

PanelConfig currentPanelConfig;

// ===== SETUP =====
void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("\n\n=== ESP32 Solar Monitor Starting ===");
  
  // Initialize pins
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, HIGH);  // Relay normally ON
  
  // Load panel configuration
  loadPanelConfig(PANEL_TYPE);
  
  // Initialize sensors
  initializeSensors();
  
  // Connect to network (WiFi preferred, GSM fallback)
  if (!connectWiFi()) {
    Serial.println("WiFi failed, falling back to GSM...");
    initializeGSM();
  }

#if OTA_ENABLED
  // OTA needs a TLS socket — only attempt it over WiFi. GSM units skip the
  // check this boot and pick it up on a later WiFi-connected loop tick.
  if (WiFi.status() == WL_CONNECTED) checkForOTA();
#endif

  Serial.println("Setup complete. Starting telemetry...");
}

// ===== MAIN LOOP =====
void loop() {
  if (millis() - lastSendTime >= UPDATE_INTERVAL) {
    collectAndSendTelemetry();
    lastSendTime = millis();
  }

#if OTA_ENABLED
  // Periodic update check — unsigned millis() arithmetic wraps safely.
  if (WiFi.status() == WL_CONNECTED && millis() - lastOtaCheck >= OTA_CHECK_INTERVAL) {
    lastOtaCheck = millis();
    checkForOTA();
  }
#endif

  delay(100);
}

// ===== SENSOR READING =====
float readVoltage() {
  int rawValue = analogRead(VOLTAGE_PIN);
  // Convert ADC (0-4095) to voltage (0-3.3V), then scale by divider ratio
  float adcVoltage = (rawValue / 4095.0) * 3.3;
  float panelVoltage = adcVoltage * VOLTAGE_CALIBRATION;
  
  // Add noise filtering (moving average)
  static float avgVoltage = 0;
  avgVoltage = (avgVoltage * 0.8) + (panelVoltage * 0.2);
  
  return constrain(avgVoltage, 0, currentPanelConfig.maxVoltage);
}

float readCurrent() {
  int rawValue = analogRead(CURRENT_PIN);
  // Convert ADC to voltage
  float adcVoltage = (rawValue / 4095.0) * 3.3;
  
  // ACS712 formula: I = (Vout - Voffset) / sensitivity
  float current = (adcVoltage - CURRENT_OFFSET) / CURRENT_SENSITIVITY;
  
  // Add noise filtering
  static float avgCurrent = 0;
  avgCurrent = (avgCurrent * 0.8) + (current * 0.2);
  
  return constrain(avgCurrent, 0, currentPanelConfig.maxCurrent);
}

int readBatteryLevel() {
  int rawValue = analogRead(BATTERY_PIN);
  // Assuming battery voltage: 20V (empty) - 58V (full) for 48V system
  float batteryVoltage = (rawValue / 4095.0) * 3.3 * VOLTAGE_CALIBRATION;
  
  // Convert to percentage (20V = 0%, 58V = 100%)
  float percentage = ((batteryVoltage - 20) / (58 - 20)) * 100;
  
  return constrain((int)percentage, 0, 100);
}

int calculateGeneration(float voltage, float current) {
  return (int)(voltage * current);  // Watts
}

int calculateEfficiency(int generation, int consumption) {
  if (generation == 0) return 0;
  // Cast to float first — integer division here always truncated to 0
  // whenever consumption < generation (the normal case).
  return (int)(((float)consumption / generation) * 100);
}

// ===== PANEL CONFIGURATION =====
void loadPanelConfig(const char* panelType) {
  for (int i = 0; i < 5; i++) {
    if (strcmp(panelConfigs[i].name, panelType) == 0) {
      currentPanelConfig = panelConfigs[i];
      /* nominalPower is an int — %.0f would read it as double and print
         garbage; %d is the correct format. */
      Serial.printf("Panel config loaded: %s (%.1fA max, %dW nom)\n",
        currentPanelConfig.name, currentPanelConfig.maxCurrent, currentPanelConfig.nominalPower);
      return;
    }
  }
  // Default to first config
  currentPanelConfig = panelConfigs[0];
  Serial.println("Panel type not found, using Monocrystalline_400W");
}

boolean validatePanelData(float voltage, float current) {
  if (voltage > currentPanelConfig.maxVoltage) {
    Serial.printf("WARNING: Voltage overshoot %.1fV (max %.1fV)\n", 
      voltage, currentPanelConfig.maxVoltage);
    return false;
  }
  
  if (current > currentPanelConfig.maxCurrent) {
    Serial.printf("WARNING: Current overshoot %.1fA (max %.1fA)\n", 
      current, currentPanelConfig.maxCurrent);
    return false;
  }
  
  return true;
}

// ===== TELEMETRY =====
void collectAndSendTelemetry() {
  // Read all sensors
  float voltage = readVoltage();
  float current = readCurrent();
  int generation = calculateGeneration(voltage, current);
  int battery = readBatteryLevel();
  int consumption = (int)(generation * 0.75);  // Simulated consumption
  int efficiency = calculateEfficiency(generation, consumption);
  
  // Validate against panel specs
  if (!validatePanelData(voltage, current)) {
    Serial.println("Sensor data out of range!");
  }
  
  // Log to serial
  Serial.printf("📊 Telemetry: V=%.1fV I=%.2fA Gen=%dW Bat=%d%% Eff=%d%%\n",
    voltage, current, generation, battery, efficiency);
  
  // Build JSON payload
  String payload = buildTelemetryJSON(voltage, current, generation, battery, consumption, efficiency);
  
  // WiFi can drop after setup() (router reboot, signal loss) and the ESP32
  // does not reconnect on its own — retry periodically rather than going
  // dark until someone physically power-cycles the device.
  if (WiFi.status() != WL_CONNECTED && millis() - lastWifiRetry >= WIFI_RETRY_INTERVAL) {
    lastWifiRetry = millis();
    Serial.println("WiFi disconnected — attempting reconnect...");
    WiFi.reconnect();
  }

  // Send to backend
  boolean success = false;

  if (WiFi.status() == WL_CONNECTED) {
    success = sendViaHTTP(payload);
  } else if (gsmReady) {
    success = sendViaGSM(payload);
  } else {
    Serial.println("No network connection available!");
  }
  
  // Relay control: the backend's "off" (wallet empty / order, not energy) always
  // wins. Otherwise honor "on" from the backend, but never above the local
  // battery safety cutoff — that protects the battery even if the backend
  // is unreachable or slow to respond.
  bool batterySafe = battery >= CRITICAL_BATTERY_PCT;
  bool shouldPowerOn = (backendRelayState == "on") && batterySafe;

  digitalWrite(RELAY_PIN, shouldPowerOn ? HIGH : LOW);
  if (!batterySafe) {
    Serial.println("🔴 Power cut: Battery critical!");
  } else if (backendRelayState != "on") {
    Serial.println("🔴 Power cut: backend reports no balance");
  } else {
    Serial.println("🟢 Power on");
  }
  
  if (!success) {
    failureCount++;
    if (failureCount >= MAX_RETRIES) {
      Serial.println("Multiple send failures - check network!");
      failureCount = 0;
    }
  } else {
    failureCount = 0;
  }
}

String buildTelemetryJSON(float voltage, float current, int generation, 
                         int battery, int consumption, int efficiency) {
  String json = "{";
  json += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  json += "\"panelType\":\"" + String(PANEL_TYPE) + "\",";
  // Lets the admin fleet panel show what each device actually runs (as
  // opposed to the OTA target the backend last offered). Sent on every
  // heartbeat so the server can flag devices stuck on an old build.
  json += "\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) + "\",";
  json += "\"voltage\":" + String(voltage, 1) + ",";
  json += "\"current\":" + String(current, 2) + ",";
  json += "\"generation\":" + String(generation) + ",";
  json += "\"battery\":" + String(battery) + ",";
  json += "\"consumption\":" + String(consumption) + ",";
  json += "\"efficiency\":" + String(efficiency) + ",";
  json += "\"timestamp\":" + String(millis());
  json += "}";
  return json;
}

// ===== NETWORK: HTTP (WiFi) =====
boolean connectWiFi() {
  const char* ssid = "YOUR_SSID";          // Update this
  const char* password = "YOUR_PASSWORD";  // Update this
  
  Serial.print("Connecting to WiFi: ");
  Serial.println(ssid);
  
  WiFi.begin(ssid, password);
  
  for (int attempts = 0; attempts < 20; attempts++) {
    if (WiFi.status() == WL_CONNECTED) {
      Serial.print("WiFi connected! IP: ");
      Serial.println(WiFi.localIP());
      return true;
    }
    delay(500);
    Serial.print(".");
  }
  
  Serial.println("\nWiFi connection failed!");
  return false;
}

boolean sendViaHTTP(String payload) {
  HTTPClient http;
  bool isHttps = String(BACKEND_URL).startsWith("https");
  WiFiClientSecure secureClient;
  bool began;

  if (isHttps) {
    // Render (and most hosted backends) only serve HTTPS. Skipping certificate
    // validation here is a pragmatic tradeoff for a low-stakes IoT device —
    // swap in setCACert() with a pinned root cert if you need stricter TLS.
    secureClient.setInsecure();
    began = http.begin(secureClient, BACKEND_URL);
  } else {
    began = http.begin(BACKEND_URL);
  }

  if (!began) {
    Serial.println("❌ HTTPClient could not connect to BACKEND_URL");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("X-Device-Key", DEVICE_API_KEY);
  }

  int httpResponseCode = http.POST(payload);

  if (httpResponseCode == 200) {
    String response = http.getString();
    applyRelayStateFromResponse(response);
    Serial.println("✅ HTTP sent successfully");
    http.end();
    return true;
  } else {
    Serial.printf("❌ HTTP failed: %d\n", httpResponseCode);
    http.end();
    return false;
  }
}

// Pulls "relayState":"on"/"off" out of the telemetry response body.
// No JSON library — just a substring search, consistent with the rest
// of this firmware's hand-built JSON handling.
void applyRelayStateFromResponse(String response) {
  if (response.indexOf("\"relayState\":\"off\"") >= 0) {
    backendRelayState = "off";
  } else if (response.indexOf("\"relayState\":\"on\"") >= 0) {
    backendRelayState = "on";
  }
  // If neither is found (e.g. malformed response), keep the last known state.
}

// ===== NETWORK: GSM (SIM800L) - For Rural Areas =====
void initializeGSM() {
  gsmSerial.begin(9600, SERIAL_8N1, 16, 17);  // baud, config, RX, TX
  delay(1000);
  
  Serial.println("Initializing GSM module...");
  sendGSMCommand("AT", 2000);
  sendGSMCommand("AT+CMGF=1", 2000);  // Text mode
  sendGSMCommand("AT+CGATT=1", 2000); // Attach to GPRS

  gsmReady = true;
  Serial.println("GSM initialized");
}

// NOTE: unlike sendViaHTTP(), this does not read back the response body
// (would need AT+HTTPREAD), so backendRelayState is NOT updated over GSM —
// the device falls back to whatever the local battery cutoff dictates.
// Wire this up if GSM is your primary connectivity (rural deployments).
boolean sendViaGSM(String payload) {
  // Using HTTP GET with GSM (simpler for unreliable networks)
  String url = BACKEND_URL;
  url += "?data=" + payload;
  
  String cmd = "AT+HTTPSEND=\"" + url + "\"";
  
  gsmSerial.println(cmd);
  delay(2000);
  
  if (gsmSerial.find("OK")) {
    Serial.println("✅ GSM sent successfully");
    return true;
  }
  
  Serial.println("❌ GSM send failed");
  return false;
}

void sendGSMCommand(const char* command, unsigned long timeout) {
  gsmSerial.println(command);
  long startTime = millis();
  
  while ((millis() - startTime) < timeout) {
    if (gsmSerial.available()) {
      String response = gsmSerial.readStringUntil('\n');
      Serial.print("GSM: ");
      Serial.println(response);
    }
  }
}

// ===== OTA UPDATES (only compiled when OTA_ENABLED=1) =====

#if OTA_ENABLED
// Compare dotted version strings like "1.2.3". Returns <0 if a<b, 0 if equal,
// >0 if a>b. Missing segments count as 0 ("1.2" == "1.2.0").
int compareVersionStrings(String a, String b) {
  int idxA = 0, idxB = 0;
  while (idxA < a.length() || idxB < b.length()) {
    int nextA = a.indexOf('.', idxA);
    int nextB = b.indexOf('.', idxB);
    int segA = a.substring(idxA, nextA < 0 ? a.length() : nextA).toInt();
    int segB = b.substring(idxB, nextB < 0 ? b.length() : nextB).toInt();
    if (segA != segB) return segA < segB ? -1 : 1;
    idxA = nextA < 0 ? a.length() : nextA + 1;
    idxB = nextB < 0 ? b.length() : nextB + 1;
  }
  return 0;
}

// Pulls "key":"value" out of the JSON-ish /latest response with a substring
// scan — same style as applyRelayStateFromResponse (no JSON library).
String extractJsonString(String json, String key) {
  String needle = "\"" + key + "\":\"";
  int start = json.indexOf(needle);
  if (start < 0) return "";
  start += needle.length();
  int end = json.indexOf('"', start);
  if (end < 0) return "";
  return json.substring(start, end);
}

/* Download the binary over HTTPS, stream it into the OTA partition while
   computing its SHA-256, and only commit (Update.end) when the digest matches
   the one the backend published. On any failure the OTA partition is aborted
   and the currently-running firmware is left untouched — the device keeps
   operating and retries on the next check. */
bool otaDownloadAndApply(String url, String expectedSha256) {
  HTTPClient http;
  WiFiClientSecure secureClient;
  secureClient.setInsecure();  // same TLS tradeoff as sendViaHTTP()
  if (!http.begin(secureClient, url)) {
    Serial.println("OTA: could not open connection");
    return false;
  }

  http.addHeader("X-Device-Id", DEVICE_ID);
  if (strlen(DEVICE_API_KEY) > 0) http.addHeader("X-Device-Key", DEVICE_API_KEY);
  http.setTimeout(15000);

  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    Serial.printf("OTA: server responded %d\n", code);
    http.end();
    return false;
  }

  int contentLength = http.getSize();
  if (contentLength <= 0) {
    Serial.println("OTA: missing content length in response");
    http.end();
    return false;
  }

  if (!Update.begin(contentLength)) {
    Serial.printf("OTA: Update.begin failed (error %d)\n", Update.getError());
    http.end();
    return false;
  }

  mbedtls_md_context_t mdCtx;
  mbedtls_md_init(&mdCtx);
  mbedtls_md_setup(&mdCtx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&mdCtx);

  WiFiClient* stream = http.getStreamPtr();
  uint8_t buf[1024];
  size_t written = 0;
  unsigned long lastDataAt = millis();
  unsigned long lastProgress = 0;

  while (stream->connected() && written < (size_t)contentLength) {
    size_t avail = stream->available();
    if (avail == 0) {
      // Stall guard — a dead connection must abort, not hang the loop forever.
      if (millis() - lastDataAt > 15000) {
        Serial.println("OTA: connection stalled — aborting");
        break;
      }
      delay(1);
      continue;
    }
    lastDataAt = millis();
    if (avail > sizeof(buf)) avail = sizeof(buf);
    size_t n = stream->readBytes(buf, avail);
    if (n == 0) continue;

    mbedtls_md_update(&mdCtx, buf, n);
    if (Update.write(buf, n) != n) {
      Serial.println("OTA: flash write short — aborting");
      written = 0;
      break;
    }
    written += n;
    if (millis() - lastProgress > 5000) {
      Serial.printf("OTA: %d / %d bytes\n", written, contentLength);
      lastProgress = millis();
    }
  }

  uint8_t digest[32];
  mbedtls_md_finish(&mdCtx, digest);
  mbedtls_md_free(&mdCtx);
  http.end();

  if (written != (size_t)contentLength) {
    Serial.printf("OTA: incomplete download (%d of %d) — aborting\n", written, contentLength);
    Update.abort();
    return false;
  }

  String actualSha256 = "";
  for (int i = 0; i < 32; i++) {
    char hex[3];
    /* (unsigned) cast: %02x expects unsigned int; digest[i] is unsigned
       char which promotes to (signed) int — avoids a -Wformat warning. */
    snprintf(hex, sizeof(hex), "%02x", (unsigned)digest[i]);
    actualSha256 += hex;
  }
  /* Fail CLOSED: a missing/malformed published checksum must abort the same
     as a mismatch — never flash an unverified binary. */
  if (expectedSha256.length() != 64 || actualSha256 != expectedSha256) {
    Serial.println("OTA: checksum missing or SHA-256 mismatch — keeping current firmware");
    Update.abort();
    return false;
  }

  if (!Update.end()) {
    Serial.printf("OTA: Update.end failed (error %d)\n", Update.getError());
    return false;
  }

  Serial.println("OTA: success — rebooting into new firmware");
  ESP.restart();
  return true;  // unreachable
}

/* Ask the backend for the latest firmware and apply it if it's newer.
   Safe when no update exists or the backend is unreachable — both are
   logged and ignored. */
void checkForOTA() {
  Serial.println("OTA: checking for updates...");
  String url = String(OTA_SERVER_BASE) + "/api/firmware/latest";

  HTTPClient http;
  WiFiClientSecure secureClient;
  secureClient.setInsecure();
  if (!http.begin(secureClient, url)) {
    Serial.println("OTA: could not reach update server");
    return;
  }

  http.addHeader("X-Device-Id", DEVICE_ID);
  if (strlen(DEVICE_API_KEY) > 0) http.addHeader("X-Device-Key", DEVICE_API_KEY);
  http.setTimeout(10000);

  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    Serial.printf("OTA: check failed (%d)\n", code);
    http.end();
    return;
  }
  String body = http.getString();
  http.end();

  String remoteVersion = extractJsonString(body, "version");
  String urlPath       = extractJsonString(body, "url");
  String checksum      = extractJsonString(body, "checksum");

  if (remoteVersion.length() == 0 || urlPath.length() == 0) {
    Serial.println("OTA: no update available");
    return;
  }

  Serial.printf("OTA: server has %s, this unit runs %s\n", remoteVersion.c_str(), FIRMWARE_VERSION);
  if (compareVersionStrings(remoteVersion, FIRMWARE_VERSION) <= 0) return;

  Serial.printf("OTA: applying %s...\n", remoteVersion.c_str());
  otaDownloadAndApply(String(OTA_SERVER_BASE) + urlPath, checksum);
}
#endif  // OTA_ENABLED

// ===== SENSOR INITIALIZATION =====
void initializeSensors() {
  // Configure ADC
  analogReadResolution(12);  // 12-bit resolution (0-4095)
  analogSetAttenuation(ADC_11db);  // 0-3.3V range
  
  Serial.println("Sensors initialized");
}
