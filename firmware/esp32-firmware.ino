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
#include <HTTPClient.h>
#include <SoftwareSerial.h>

// ===== CONFIGURATION =====
#define BACKEND_URL "http://your-backend.com/api/telemetry"  // Update this — must end in /api/telemetry
#define DEVICE_API_KEY ""  // Optional — must match DEVICE_API_KEY env var on the backend, leave blank to disable
#define DEVICE_ID "SOLAR_DEVICE_001"
#define PANEL_TYPE "Monocrystalline_400W"  // Panel configuration
#define UPDATE_INTERVAL 5000  // Send data every 5 seconds

// Local safety cutoff: power is forced off below this battery % regardless
// of what the backend says, to protect the battery from over-discharge.
#define CRITICAL_BATTERY_PCT 10

// Sensor Pin Definitions
#define VOLTAGE_PIN 35      // ADC1_7 - Voltage sensor
#define CURRENT_PIN 34      // ADC1_6 - Current sensor
#define BATTERY_PIN 32      // ADC1_4 - Battery level
#define RELAY_PIN 4         // Digital - Power relay control

// SoftwareSerial for GSM
SoftwareSerial gsmSerial(16, 17);  // RX, TX

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
  
  Serial.println("Setup complete. Starting telemetry...");
}

// ===== MAIN LOOP =====
void loop() {
  if (millis() - lastSendTime >= UPDATE_INTERVAL) {
    collectAndSendTelemetry();
    lastSendTime = millis();
  }
  
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
  return (consumption / generation) * 100;
}

// ===== PANEL CONFIGURATION =====
void loadPanelConfig(const char* panelType) {
  for (int i = 0; i < 5; i++) {
    if (strcmp(panelConfigs[i].name, panelType) == 0) {
      currentPanelConfig = panelConfigs[i];
      Serial.printf("Panel config loaded: %s (%.1fA max, %.0fW nom)\n",
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
  
  // Send to backend
  boolean success = false;
  
  if (WiFi.status() == WL_CONNECTED) {
    success = sendViaHTTP(payload);
  } else if (gsmSerial.available()) {
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
  http.begin(BACKEND_URL);
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
  gsmSerial.begin(9600);
  delay(1000);
  
  Serial.println("Initializing GSM module...");
  sendGSMCommand("AT", 2000);
  sendGSMCommand("AT+CMGF=1", 2000);  // Text mode
  sendGSMCommand("AT+CGATT=1", 2000); // Attach to GPRS
  
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

// ===== SENSOR INITIALIZATION =====
void initializeSensors() {
  // Configure ADC
  analogReadResolution(12);  // 12-bit resolution (0-4095)
  analogSetAttenuation(ADC_11db);  // 0-3.3V range
  
  Serial.println("Sensors initialized");
}
