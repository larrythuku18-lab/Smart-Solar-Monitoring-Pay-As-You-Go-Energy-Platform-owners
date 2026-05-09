import dotenv from 'dotenv';
import { query, closePool } from '../models/db.js';
import { createUser } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

async function seedDatabase() {
  try {
    console.log('🌱 Seeding database with demo users and devices...');

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@solarpayg.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@12345';

    const users = [
      {
        email: adminEmail,
        phone: '+254700000000',
        password: adminPassword,
        role: 'admin',
        firstName: 'System',
        lastName: 'Administrator'
      },
      {
        email: 'agent@solarpayg.com',
        phone: '+254711111111',
        password: 'Agent@12345',
        role: 'agent',
        firstName: 'Field',
        lastName: 'Agent'
      },
      {
        email: 'customer1@solarpayg.com',
        phone: '+254722222222',
        password: 'Customer@12345',
        role: 'customer',
        firstName: 'Jane',
        lastName: 'Njeri'
      },
      {
        email: 'customer2@solarpayg.com',
        phone: '+254733333333',
        password: 'Customer@12345',
        role: 'customer',
        firstName: 'Peter',
        lastName: 'Otieno'
      },
      {
        email: 'customer3@solarpayg.com',
        phone: '+254744444444',
        password: 'Customer@12345',
        role: 'customer',
        firstName: 'Amina',
        lastName: 'Mwangi'
      }
    ];

    const createdUsers = {};

    for (const user of users) {
      try {
        const created = await createUser(user);
        createdUsers[user.email] = created.id;
        console.log(`✅ User created: ${user.email} (${user.role})`);
      } catch (err) {
        const existing = await query('SELECT id FROM users WHERE email = $1', [user.email]);
        if (existing.rows.length > 0) {
          createdUsers[user.email] = existing.rows[0].id;
          console.log(`ℹ️  User already exists: ${user.email}`);
        } else {
          throw err;
        }
      }
    }

    const demoDevices = [
      {
        deviceId: 'SOLAR-0001',
        userEmail: 'customer1@solarpayg.com',
        name: 'Ruiru Solar System',
        location_lat: -1.1175,
        location_lng: 36.7831,
        location_address: 'Ruiru, Kenya',
        panel_type: 'Monocrystalline 400W',
        battery_capacity_kwh: 6.5
      },
      {
        deviceId: 'SOLAR-0002',
        userEmail: 'customer2@solarpayg.com',
        name: 'Kitengela Solar Unit',
        location_lat: -1.4750,
        location_lng: 36.8850,
        location_address: 'Kitengela, Kenya',
        panel_type: 'Polycrystalline 300W',
        battery_capacity_kwh: 5.0
      }
    ];

    for (const device of demoDevices) {
      const ownerId = createdUsers[device.userEmail];
      if (!ownerId) continue;

      try {
        await query(
          `INSERT INTO devices (device_id, user_id, name, location_lat, location_lng, location_address, panel_type, battery_capacity_kwh)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [device.deviceId, ownerId, device.name, device.location_lat, device.location_lng, device.location_address, device.panel_type, device.battery_capacity_kwh]
        );
        console.log(`✅ Device created: ${device.deviceId} for ${device.userEmail}`);
      } catch (err) {
        console.log(`ℹ️  Device already exists: ${device.deviceId}`);
      }
    }

    console.log('✅ Database seed complete.');
  } catch (err) {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  } finally {
    await closePool();
    process.exit(0);
  }
}

seedDatabase();
