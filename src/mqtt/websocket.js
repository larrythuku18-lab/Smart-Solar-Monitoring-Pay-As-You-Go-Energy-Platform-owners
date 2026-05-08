import { Server } from 'socket.io';

// WebSocket event types
export const WS_EVENTS = {
  // Client -> Server
  JOIN_ROOM: 'join_room',
  LEAVE_ROOM: 'leave_room',
  SUBSCRIBE_DEVICE: 'subscribe_device',
  UNSUBSCRIBE_DEVICE: 'unsubscribe_device',

  // Server -> Client
  ENERGY_UPDATE: 'energy_update',
  PAYMENT_CONFIRMED: 'payment_confirmed',
  ALERT_TRIGGERED: 'alert_triggered',
  DEVICE_STATUS: 'device_status',
  AI_PREDICTION: 'ai_prediction',
  TOKEN_GENERATED: 'token_generated',

  // Connection events
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  ERROR: 'error'
};

class WebSocketManager {
  constructor() {
    this.io = null;
    this.connectedClients = new Map(); // clientId -> user data
    this.deviceSubscriptions = new Map(); // deviceId -> Set of clientIds
  }

  // Initialize Socket.io server
  initialize(httpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.NODE_ENV === 'production' ? false : "*",
        methods: ["GET", "POST"],
        credentials: true
      },
      transports: ['websocket', 'polling']
    });

    this.setupEventHandlers();
    console.log('✅ WebSocket server initialized');
  }

  // Setup event handlers
  setupEventHandlers() {
    this.io.on(WS_EVENTS.CONNECT, (socket) => {
      console.log(`🔌 Client connected: ${socket.id}`);

      // Store client connection
      this.connectedClients.set(socket.id, {
        connectedAt: new Date(),
        subscriptions: new Set()
      });

      // Handle room joining (for user-specific updates)
      socket.on(WS_EVENTS.JOIN_ROOM, (data) => {
        const { userId, role } = data;
        socket.join(`user_${userId}`);
        socket.join(`role_${role}`);
        console.log(`👤 ${socket.id} joined rooms: user_${userId}, role_${role}`);
      });

      // Handle device subscriptions
      socket.on(WS_EVENTS.SUBSCRIBE_DEVICE, (deviceId) => {
        this.subscribeToDevice(socket.id, deviceId);
        socket.join(`device_${deviceId}`);
        console.log(`📡 ${socket.id} subscribed to device: ${deviceId}`);
      });

      socket.on(WS_EVENTS.UNSUBSCRIBE_DEVICE, (deviceId) => {
        this.unsubscribeFromDevice(socket.id, deviceId);
        socket.leave(`device_${deviceId}`);
        console.log(`📡 ${socket.id} unsubscribed from device: ${deviceId}`);
      });

      // Handle disconnection
      socket.on(WS_EVENTS.DISCONNECT, () => {
        console.log(`🔌 Client disconnected: ${socket.id}`);
        this.handleClientDisconnect(socket.id);
      });

      // Handle connection errors
      socket.on('error', (error) => {
        console.error(`WebSocket error for ${socket.id}:`, error);
      });
    });
  }

  // Subscribe client to device updates
  subscribeToDevice(clientId, deviceId) {
    if (!this.deviceSubscriptions.has(deviceId)) {
      this.deviceSubscriptions.set(deviceId, new Set());
    }
    this.deviceSubscriptions.get(deviceId).add(clientId);

    const clientData = this.connectedClients.get(clientId);
    if (clientData) {
      clientData.subscriptions.add(deviceId);
    }
  }

  // Unsubscribe client from device updates
  unsubscribeFromDevice(clientId, deviceId) {
    const deviceSubs = this.deviceSubscriptions.get(deviceId);
    if (deviceSubs) {
      deviceSubs.delete(clientId);
      if (deviceSubs.size === 0) {
        this.deviceSubscriptions.delete(deviceId);
      }
    }

    const clientData = this.connectedClients.get(clientId);
    if (clientData) {
      clientData.subscriptions.delete(deviceId);
    }
  }

  // Handle client disconnection
  handleClientDisconnect(clientId) {
    const clientData = this.connectedClients.get(clientId);
    if (clientData) {
      // Remove from all device subscriptions
      clientData.subscriptions.forEach(deviceId => {
        this.unsubscribeFromDevice(clientId, deviceId);
      });
    }
    this.connectedClients.delete(clientId);
  }

  // Broadcast energy update to subscribed clients
  broadcastEnergyUpdate(deviceId, data) {
    const eventData = {
      deviceId,
      ...data,
      timestamp: new Date()
    };

    // Send to device-specific room
    this.io.to(`device_${deviceId}`).emit(WS_EVENTS.ENERGY_UPDATE, eventData);

    console.log(`📊 Energy update broadcasted for device ${deviceId}`);
  }

  // Broadcast payment confirmation
  broadcastPaymentConfirmation(userId, paymentData) {
    const eventData = {
      ...paymentData,
      timestamp: new Date()
    };

    // Send to user-specific room
    this.io.to(`user_${userId}`).emit(WS_EVENTS.PAYMENT_CONFIRMED, eventData);

    // Also send to admin rooms
    this.io.to('role_admin').emit(WS_EVENTS.PAYMENT_CONFIRMED, eventData);

    console.log(`💳 Payment confirmation broadcasted for user ${userId}`);
  }

  // Broadcast alert to relevant users
  broadcastAlert(alertData) {
    const eventData = {
      ...alertData,
      timestamp: new Date()
    };

    // Send to device owner
    if (alertData.userId) {
      this.io.to(`user_${alertData.userId}`).emit(WS_EVENTS.ALERT_TRIGGERED, eventData);
    }

    // Send to all admins and agents
    this.io.to('role_admin').emit(WS_EVENTS.ALERT_TRIGGERED, eventData);
    this.io.to('role_agent').emit(WS_EVENTS.ALERT_TRIGGERED, eventData);

    console.log(`🚨 Alert broadcasted: ${alertData.title}`);
  }

  // Broadcast device status update
  broadcastDeviceStatus(deviceId, statusData) {
    const eventData = {
      deviceId,
      ...statusData,
      timestamp: new Date()
    };

    // Send to device subscribers
    this.io.to(`device_${deviceId}`).emit(WS_EVENTS.DEVICE_STATUS, eventData);

    console.log(`📡 Device status broadcasted for ${deviceId}`);
  }

  // Broadcast AI prediction results
  broadcastAIPrediction(deviceId, predictionData) {
    const eventData = {
      deviceId,
      ...predictionData,
      timestamp: new Date()
    };

    // Send to device subscribers
    this.io.to(`device_${deviceId}`).emit(WS_EVENTS.AI_PREDICTION, eventData);

    console.log(`🤖 AI prediction broadcasted for ${deviceId}`);
  }

  // Broadcast token generation
  broadcastTokenGenerated(userId, tokenData) {
    const eventData = {
      ...tokenData,
      timestamp: new Date()
    };

    // Send to user-specific room
    this.io.to(`user_${userId}`).emit(WS_EVENTS.TOKEN_GENERATED, eventData);

    console.log(`🎫 Token generation broadcasted for user ${userId}`);
  }

  // Send notification to specific user
  sendToUser(userId, event, data) {
    this.io.to(`user_${userId}`).emit(event, {
      ...data,
      timestamp: new Date()
    });
  }

  // Send notification to all users with specific role
  sendToRole(role, event, data) {
    this.io.to(`role_${role}`).emit(event, {
      ...data,
      timestamp: new Date()
    });
  }

  // Get connection statistics
  getStats() {
    return {
      connectedClients: this.connectedClients.size,
      deviceSubscriptions: this.deviceSubscriptions.size,
      totalSubscriptions: Array.from(this.deviceSubscriptions.values())
        .reduce((sum, subs) => sum + subs.size, 0)
    };
  }

  // Graceful shutdown
  shutdown() {
    if (this.io) {
      this.io.close();
      console.log('🔌 WebSocket server shut down');
    }
  }
}

// Global WebSocket manager instance
export const wsManager = new WebSocketManager();

// Make available globally for MQTT integration
global.wsManager = wsManager;