import mqtt from 'mqtt';

// MQTT Configuration
const MQTT_CONFIG = {
  brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  clientId: `solarpayg-server-${Date.now()}`,
  reconnectPeriod: 5000,
  connectTimeout: 30000
};

// MQTT Topics
const TOPICS = {
  // Device data topics (subscribe)
  DEVICE_DATA: 'solar/+/data',           // solar/{device_id}/data
  DEVICE_STATUS: 'solar/+/status',       // solar/{device_id}/status

  // Control topics (publish)
  DEVICE_CONTROL: 'solar/{device_id}/control',  // solar/{device_id}/control

  // Broadcast topics
  BROADCAST_CONTROL: 'solar/all/control',
  SYSTEM_STATUS: 'solar/system/status'
};

class MQTTManager {
  constructor() {
    this.client = null;
    this.connected = false;
    this.subscriptions = new Map();
    this.messageHandlers = new Map();
  }

  // Connect to MQTT broker
  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.client = mqtt.connect(MQTT_CONFIG.brokerUrl, {
          clientId: MQTT_CONFIG.clientId,
          username: MQTT_CONFIG.username,
          password: MQTT_CONFIG.password,
          reconnectPeriod: MQTT_CONFIG.reconnectPeriod,
          connectTimeout: MQTT_CONFIG.connectTimeout,
          clean: true
        });

        this.client.on('connect', () => {
          console.log('✅ MQTT connected to', MQTT_CONFIG.brokerUrl);
          this.connected = true;
          this.subscribeToTopics();
          resolve();
        });

        this.client.on('error', (error) => {
          console.error('❌ MQTT connection error:', error);
          this.connected = false;
          reject(error);
        });

        this.client.on('offline', () => {
          console.log('⚠️ MQTT client offline');
          this.connected = false;
        });

        this.client.on('reconnect', () => {
          console.log('🔄 MQTT reconnecting...');
        });

        this.client.on('message', (topic, message) => {
          this.handleMessage(topic, message);
        });

      } catch (error) {
        console.error('MQTT initialization error:', error);
        reject(error);
      }
    });
  }

  // Subscribe to device topics
  subscribeToTopics() {
    const topics = [
      TOPICS.DEVICE_DATA,
      TOPICS.DEVICE_STATUS
    ];

    topics.forEach(topic => {
      this.client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          console.error(`Failed to subscribe to ${topic}:`, err);
        } else {
          console.log(`✅ Subscribed to ${topic}`);
        }
      });
    });
  }

  // Handle incoming messages
  handleMessage(topic, message) {
    try {
      const payload = JSON.parse(message.toString());
      const deviceId = this.extractDeviceId(topic);

      console.log(`📨 MQTT message received: ${topic}`, { deviceId, payload });

      // Route message based on topic type
      if (topic.includes('/data')) {
        this.handleDeviceData(deviceId, payload);
      } else if (topic.includes('/status')) {
        this.handleDeviceStatus(deviceId, payload);
      }

      // Call registered handlers
      const handlers = this.messageHandlers.get(topic) || [];
      handlers.forEach(handler => {
        try {
          handler(deviceId, payload);
        } catch (error) {
          console.error('Message handler error:', error);
        }
      });

    } catch (error) {
      console.error('MQTT message parsing error:', error);
    }
  }

  // Extract device ID from topic
  extractDeviceId(topic) {
    const match = topic.match(/solar\/([^\/]+)\/.+/);
    return match ? match[1] : null;
  }

  // Handle device data messages
  handleDeviceData(deviceId, data) {
    // Store in database and emit to WebSocket clients
    const reading = {
      device_id: deviceId,
      generation_watts: data.generation || 0,
      consumption_watts: data.consumption || 0,
      battery_level_percent: data.batteryLevel || 0,
      voltage_volts: data.voltage || 0,
      current_amps: data.current || 0,
      efficiency_percent: data.efficiency || 0,
      temperature_celsius: data.temperature || 0,
      irradiance_w_m2: data.irradiance || 0,
      relay_status: data.relayStatus || false
    };

    // Emit to WebSocket clients
    if (global.io) {
      global.io.emit('energy_update', { deviceId, ...reading });
    }
  }

  // Handle device status messages
  handleDeviceStatus(deviceId, status) {
    // Update device last_seen and status
    const statusData = {
      device_id: deviceId,
      online: status.online || false,
      firmware_version: status.firmwareVersion,
      uptime_seconds: status.uptime,
      signal_strength: status.signalStrength
    };

    // Emit to WebSocket clients
    if (global.io) {
      global.io.emit('device_status', statusData);
    }
  }

  // Send control command to device
  async sendControlCommand(deviceId, command) {
    if (!this.connected) {
      throw new Error('MQTT client not connected');
    }

    const topic = TOPICS.DEVICE_CONTROL.replace('{device_id}', deviceId);
    const payload = JSON.stringify(command);

    return new Promise((resolve, reject) => {
      this.client.publish(topic, payload, { qos: 1 }, (error) => {
        if (error) {
          console.error(`Failed to publish to ${topic}:`, error);
          reject(error);
        } else {
          console.log(`📤 MQTT command sent to ${deviceId}:`, command);
          resolve();
        }
      });
    });
  }

  // Send relay control command
  async controlRelay(deviceId, state) {
    const command = {
      command: 'relay_control',
      relay: state, // true = ON, false = OFF
      timestamp: Date.now()
    };

    return this.sendControlCommand(deviceId, command);
  }

  // Send configuration update
  async updateDeviceConfig(deviceId, config) {
    const command = {
      command: 'config_update',
      config: config,
      timestamp: Date.now()
    };

    return this.sendControlCommand(deviceId, command);
  }

  // Broadcast command to all devices
  async broadcastCommand(command) {
    if (!this.connected) {
      throw new Error('MQTT client not connected');
    }

    const payload = JSON.stringify({
      ...command,
      timestamp: Date.now()
    });

    return new Promise((resolve, reject) => {
      this.client.publish(TOPICS.BROADCAST_CONTROL, payload, { qos: 1 }, (error) => {
        if (error) {
          reject(error);
        } else {
          console.log('📤 MQTT broadcast sent:', command);
          resolve();
        }
      });
    });
  }

  // Register message handler
  onMessage(topic, handler) {
    if (!this.messageHandlers.has(topic)) {
      this.messageHandlers.set(topic, []);
    }
    this.messageHandlers.get(topic).push(handler);
  }

  // Disconnect
  disconnect() {
    if (this.client) {
      this.client.end();
      this.connected = false;
      console.log('🔌 MQTT disconnected');
    }
  }

  // Get connection status
  isConnected() {
    return this.connected;
  }
}

// Global MQTT manager instance
export const mqttManager = new MQTTManager();

// Graceful shutdown
process.on('SIGINT', () => {
  mqttManager.disconnect();
});

process.on('SIGTERM', () => {
  mqttManager.disconnect();
});