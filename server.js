const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const webpush = require('web-push');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =============================
// ENVIRONMENT VARIABLES
// =============================

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@order-app.com';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing');
  process.exit(1);
}

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('VAPID keys are missing');
  process.exit(1);
}

// =============================
// DATABASE
// =============================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_number INTEGER NOT NULL,
      client_name TEXT NOT NULL,
      products JSONB,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT UNIQUE NOT NULL,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log('Database initialized');
}

// =============================
// PUSH NOTIFICATIONS
// =============================

webpush.setVapidDetails(
  VAPID_EMAIL,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// =============================
// DATABASE HELPERS
// =============================

function dbOrderToObject(row) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    clientName: row.client_name,
    products: row.products,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

async function getOrders() {
  const result = await pool.query(`
    SELECT *
    FROM orders
    ORDER BY order_number DESC
  `);

  return result.rows.map(dbOrderToObject);
}

async function getNextOrderNumber() {
  const result = await pool.query(`
    SELECT COALESCE(MAX(order_number), 0) + 1 AS next_number
    FROM orders
  `);

  return Number(result.rows[0].next_number);
}

// =============================
// REAL-TIME UPDATES
// =============================

async function emitUpdate() {
  const orders = await getOrders();
  io.emit('orders-updated', orders);
}

// =============================
// PUSH NOTIFICATION HELPERS
// =============================

async function getSubscriptions() {
  const result = await pool.query(`
    SELECT subscription
    FROM subscriptions
  `);

  return result.rows.map(row => row.subscription);
}

async function sendPushToAll(title, body, excludeSubscription = null) {
  const payload = JSON.stringify({
    title,
    body
  });

  const subscriptions = await getSubscriptions();

  for (const sub of subscriptions) {
    if (
      excludeSubscription &&
      sub.endpoint === excludeSubscription.endpoint
    ) {
      continue;
    }

    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        try {
          await pool.query(
            `DELETE FROM subscriptions WHERE endpoint = $1`,
            [sub.endpoint]
          );
        } catch (deleteError) {
          console.error('Error removing expired subscription:', deleteError);
        }
      } else {
        console.error('Push notification error:', err.message);
      }
    }
  }
}

// =============================
// ORDER FUNCTIONS
// =============================

async function createOrder(data) {
  const id = uuidv4();
  const orderNumber = await getNextOrderNumber();
  const createdAt = new Date();

  const result = await pool.query(
    `
      INSERT INTO orders
      (
        id,
        order_number,
        client_name,
        products,
        status,
        created_at,
        completed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `,
    [
      id,
      orderNumber,
      data.clientName,
      JSON.stringify(data.products || []),
      'active',
      createdAt,
      null
    ]
  );

  const order = dbOrderToObject(result.rows[0]);

  await emitUpdate();

  return order;
}

async function updateOrder(id, data) {
  const existingResult = await pool.query(
    `SELECT * FROM orders WHERE id = $1`,
    [id]
  );

  if (existingResult.rows.length === 0) {
    return null;
  }

  const existing = existingResult.rows[0];

  const clientName =
    data.clientName !== undefined
      ? data.clientName
      : existing.client_name;

  const products =
    data.products !== undefined
      ? data.products
      : existing.products;

  const status =
    data.status !== undefined
      ? data.status
      : existing.status;

  const result = await pool.query(
    `
      UPDATE orders
      SET
        client_name = $1,
        products = $2,
        status = $3
      WHERE id = $4
      RETURNING *
    `,
    [
      clientName,
      JSON.stringify(products || []),
      status,
      id
    ]
  );

  await emitUpdate();

  return dbOrderToObject(result.rows[0]);
}

async function completeOrder(id) {
  const completedAt = new Date();

  const result = await pool.query(
    `
      UPDATE orders
      SET
        status = 'completed',
        completed_at = $1
      WHERE id = $2
      RETURNING *
    `,
    [completedAt, id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const order = dbOrderToObject(result.rows[0]);

  await emitUpdate();

  return order;
}

async function deleteOrder(id) {
  const result = await pool.query(
    `DELETE FROM orders WHERE id = $1 RETURNING id`,
    [id]
  );

  if (result.rows.length === 0) {
    return false;
  }

  await emitUpdate();

  return true;
}

// =============================
// API ROUTES
// =============================

app.get('/api/vapid-public-key', (req, res) => {
  res.json({
    publicKey: VAPID_PUBLIC_KEY
  });
});

app.post('/api/subscribe', async (req, res) => {
  try {
    const sub = req.body;

    if (!sub || !sub.endpoint) {
      return res.status(400).json({
        message: 'Invalid subscription'
      });
    }

    await pool.query(
      `
        INSERT INTO subscriptions (endpoint, subscription)
        VALUES ($1, $2)
        ON CONFLICT (endpoint)
        DO UPDATE SET subscription = EXCLUDED.subscription
      `,
      [
        sub.endpoint,
        JSON.stringify(sub)
      ]
    );

    res.status(201).json({
      message: 'Subscribed'
    });
  } catch (err) {
    console.error('Subscription error:', err);
    res.status(500).json({
      message: 'Subscription failed'
    });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const orders = await getOrders();
    res.json(orders);
  } catch (err) {
    console.error('Get orders error:', err);
    res.status(500).json({
      message: 'Failed to get orders'
    });
  }
});

// =============================
// SOCKET.IO
// =============================

io.on('connection', async (socket) => {
  try {
    const orders = await getOrders();

    socket.emit('orders-updated', orders);
  } catch (err) {
    console.error('Initial order load error:', err);
  }

  socket.on('new-order', async (data) => {
    try {
      const order = await createOrder(data);

      socket.broadcast.emit('new-order-notification', {
        orderNumber: order.orderNumber,
        clientName: order.clientName
      });

      await sendPushToAll(
        `New Order #${order.orderNumber}`,
        `Client: ${order.clientName}`
      );
    } catch (err) {
      console.error('Create order error:', err);
    }
  });

  socket.on('update-order', async ({ id, data }) => {
    try {
      await updateOrder(id, data);
    } catch (err) {
      console.error('Update order error:', err);
    }
  });

  socket.on('complete-order', async (id) => {
    try {
      const order = await completeOrder(id);

      if (order) {
        await sendPushToAll(
          `Order #${order.orderNumber} Completed`,
          `Client: ${order.clientName}`
        );
      }
    } catch (err) {
      console.error('Complete order error:', err);
    }
  });

  socket.on('delete-order', async (id) => {
    try {
      await deleteOrder(id);
    } catch (err) {
      console.error('Delete order error:', err);
    }
  });
});

// =============================
// START SERVER
// =============================

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initializeDatabase();

    server.listen(PORT, () => {
      console.log(`Order app running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
