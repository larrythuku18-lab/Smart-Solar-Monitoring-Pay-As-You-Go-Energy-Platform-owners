import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';
import { Server } from 'socket.io';

// Import routes
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import tokenRoutes from './routes/tokens.js';
import paymentRoutes from './routes/payments.js';
import dashboardRoutes from './routes/dashboard.js';
import energyRoutes from './routes/energy.js';
import aiRoutes from './routes/ai.js';
// Africa's Talking is imported as a service in payment routes, not as a route

// Import services
import { mqttManager } from './mqtt/mqtt-client.js';
import { wsManager } from './mqtt/websocket.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting - Global
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
});
app.use(globalLimiter);

// Rate limiting - Login endpoint (stricter)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 login attempts per windowMs
  message: 'Too many login attempts, please try again later.',
  skipSuccessfulRequests: true, // Don't count successful requests
});

// Rate limiting - M-Pesa callback (less strict for webhook)
const mpesaLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Allow more requests for webhooks
  message: 'Too many M-Pesa callbacks',
  skipSuccessfulRequests: false,
});

// Static files
app.use(express.static(join(__dirname, '../public')));

// Routes
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/tokens', tokenRoutes);
app.use('/api/payments/callback', mpesaLimiter);
app.use('/api/payments', paymentRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/energy', energyRoutes);
app.use('/api/ai', aiRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Solar PAYG Platform API',
    version: '3.0.0',
    endpoints: {
      auth: '/api/auth',
      devices: '/api/devices',
      tokens: '/api/tokens',
      payments: '/api/payments',
      dashboard: '/api/dashboard'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// Initialize services
async function startServer() {
  try {
    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

if (process.env.NODE_ENV !== 'test') {
  startServer();
}

export { app, httpServer };
export default app;
