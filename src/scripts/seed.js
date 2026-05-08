import { query, closePool } from '../models/db.js';
import { createUser } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

async function seedDatabase() {
  try {
    console.log('🌱 Seeding database with sample data...');

    // Create admin user
    try {
      const admin = await createUser('admin@solarpaygo.com', 'Admin@12345', 'admin');
      console.log('✅ Admin user created:', admin.email);
    } catch (error) {
      console.log('ℹ️  Admin user already exists');
    }

    // Create agent user
    try {
      const agent = await createUser('agent@solarpaygo.com', 'Agent@12345', 'agent');
      console.log('✅ Agent user created:', agent.email);
    } catch (error) {
      console.log('ℹ️  Agent user already exists');
    }

    // Create sample customer
    let customerId;
    try {
      const customer = await createUser('customer@solarpaygo.com', 'Customer@12345', 'customer');
      customerId = customer.id;
      console.log('✅ Customer user created:', customer.email);
    } catch (error) {
      // Get existing customer ID
      const result = await query("SELECT id FROM users WHERE email = 'customer@solarpaygo.com'");
      if (result.rows.length > 0) {
        customerId = result.rows[0].id;
        console.log('ℹ️  Customer user already exists');
      }
    }

    // Create sample devices
    if (customerId) {
      const devices = [
        {
          name: 'Main Solar Panel',
          type: 'solar_panel',
          capacity: 500,
          battery: 100,
          location: 'Roof',
        },
        {
          name: 'Backup Inverter',
          type: 'inverter',
          capacity: 3000,
          battery: 50,
          location: 'Garage',
        },
      ];

      for (const device of devices) {
        try {
          const deviceId = uuidv4();
          await query(
            `INSERT INTO devices (device_id, user_id, name, device_type, panel_capacity_w, battery_capacity_kwh, location, current_battery_kwh, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
            [deviceId, customerId, device.name, device.type, device.capacity, device.battery, device.location, device.battery / 2]
          );
          console.log(`✅ Device created: ${device.name} (${deviceId})`);
        } catch (error) {
          console.log(`ℹ️  Device ${device.name} already exists`);
        }
      }
    }

    console.log('✅ Database seeding completed successfully!');
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  } finally {
    await closePool();
    process.exit(0);
  }
}

seedDatabase();
