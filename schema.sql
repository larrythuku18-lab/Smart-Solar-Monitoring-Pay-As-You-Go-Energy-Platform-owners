-- SolarPAYG Platform Database Schema
-- PostgreSQL 14+ compatible

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (customers, agents, admins)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(20) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'agent', 'customer')),
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP WITH TIME ZONE,
    refresh_token VARCHAR(500),
    token_expires_at TIMESTAMP WITH TIME ZONE
);

-- Devices table (solar panels/installations)
CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id VARCHAR(50) UNIQUE NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100),
    location_lat DECIMAL(10, 8),
    location_lng DECIMAL(11, 8),
    location_address TEXT,
    panel_type VARCHAR(100),
    battery_capacity_kwh DECIMAL(5, 2),
    installation_date DATE,
    is_active BOOLEAN DEFAULT true,
    last_seen TIMESTAMP WITH TIME ZONE,
    firmware_version VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Energy readings table
CREATE TABLE energy_readings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    generation_watts DECIMAL(8, 2),
    consumption_watts DECIMAL(8, 2),
    battery_level_percent DECIMAL(5, 2),
    voltage_volts DECIMAL(6, 2),
    current_amps DECIMAL(6, 2),
    efficiency_percent DECIMAL(5, 2),
    temperature_celsius DECIMAL(5, 2),
    irradiance_w_m2 DECIMAL(7, 2),
    relay_status BOOLEAN DEFAULT true
);

-- Payments table (M-Pesa transactions)
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    transaction_id VARCHAR(50) UNIQUE,
    merchant_request_id VARCHAR(50),
    checkout_request_id VARCHAR(50) UNIQUE,
    amount_kes DECIMAL(10, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
    phone_number VARCHAR(20),
    mpesa_receipt_number VARCHAR(20),
    result_code VARCHAR(10),
    result_desc TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE
);

-- PAYG Tokens table
CREATE TABLE tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    token_value VARCHAR(20) UNIQUE NOT NULL,
    amount_kes DECIMAL(8, 2),
    kwh_value DECIMAL(6, 2),
    is_used BOOLEAN DEFAULT false,
    used_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    signature VARCHAR(128),
    sms_sent BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Alerts table
CREATE TABLE alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    alert_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
    title VARCHAR(200) NOT NULL,
    message TEXT,
    is_acknowledged BOOLEAN DEFAULT false,
    acknowledged_at TIMESTAMP WITH TIME ZONE,
    acknowledged_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE
);

-- AI Predictions table
CREATE TABLE ai_predictions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    prediction_type VARCHAR(50) NOT NULL,
    model_version VARCHAR(20),
    input_data JSONB,
    prediction_result JSONB,
    confidence_score DECIMAL(5, 4),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_energy_readings_device_timestamp ON energy_readings(device_id, timestamp DESC);
CREATE INDEX idx_energy_readings_timestamp ON energy_readings(timestamp DESC);
CREATE INDEX idx_payments_user_created ON payments(user_id, created_at DESC);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_tokens_user_device ON tokens(user_id, device_id);
CREATE INDEX idx_tokens_value ON tokens(token_value);
CREATE INDEX idx_tokens_expires ON tokens(expires_at);
CREATE INDEX idx_alerts_device_created ON alerts(device_id, created_at DESC);
CREATE INDEX idx_alerts_user_created ON alerts(user_id, created_at DESC);
CREATE INDEX idx_alerts_unacknowledged ON alerts(is_acknowledged) WHERE is_acknowledged = false;
CREATE INDEX idx_devices_user ON devices(user_id);
CREATE INDEX idx_devices_active ON devices(is_active) WHERE is_active = true;

-- Triggers for updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_devices_updated_at BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default admin user (password: admin123 - change in production!)
INSERT INTO users (email, phone, password_hash, role, first_name, last_name) VALUES
('admin@solarpayg.com', '+254700000000', '$2b$10$rOz8vZKQ8K8vZKQ8K8vZKQ8K8vZKQ8K8vZKQ8K8vZKQ8K8vZKQ8K8vZK', 'admin', 'System', 'Administrator');

-- Insert sample customer
INSERT INTO users (email, phone, password_hash, role, first_name, last_name) VALUES
('customer@example.com', '+254711111111', '$2b$10$rOz8vZKQ8K8vZKQ8K8vZKQ8K8vZKQ8K8vZKQ8K8vZKQ8K8vZKQ8K8vZK', 'customer', 'John', 'Doe');

-- Insert sample device
INSERT INTO devices (device_id, user_id, name, location_lat, location_lng, location_address, panel_type, battery_capacity_kwh) VALUES
('SOLAR001', (SELECT id FROM users WHERE email = 'customer@example.com'), 'Home Solar System', -1.2864, 36.8172, 'Nairobi, Kenya', 'Monocrystalline_400W', 5.0);