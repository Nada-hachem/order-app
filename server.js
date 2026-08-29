const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const VAPID_PUBLIC_KEY = 'BLtcJjyriIsgCLN-fuYUc9TaDexhFkAKVCiBcx1ihIzEEndzvY8CBHDORo81rWqgfBtv_wtVv6pY6GsF87Zd7UA';
const VAPID_PRIVATE_KEY = 'TpyO3P5nbTmkw-oaK-u4Le4X0JpRPMPG5e_50EKChY4';

webpush.setVapidDetails(
  'mailto:admin@order-app.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

let orders = [];
let nextOrderNumber = 1;
let subscriptions = [];

function emitUpdate() {
  io.emit('orders-updated', orders);
}

async function sendPushToAll(title, body, excludeSubscription = null) {
  const payload = JSON.stringify({ title, body });
  const toRemove = [];
  for (const sub of subscriptions) {
    if (excludeSubscription && sub.endpoint === excludeSubscription.endpoint) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        toRemove.push(sub.endpoint);
      }
    }
  }
  subscriptions = subscriptions.filter(s => !toRemove.includes(s.endpoint));
}

function createOrder(data) {
  const order = {
    id: uuidv4(),
    orderNumber: nextOrderNumber++,
    clientName: data.clientName,
    products: data.products,
    status: 'active',
    createdAt: new Date().toISOString(),
    completedAt: null
  };
  orders.push(order);
  emitUpdate();
  return order;
}

function updateOrder(id, data) {
  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1) return null;
  orders[idx] = { ...orders[idx], ...data };
  emitUpdate();
  return orders[idx];
}

function completeOrder(id) {
  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1) return null;
  orders[idx].status = 'completed';
  orders[idx].completedAt = new Date().toISOString();
  emitUpdate();
  return orders[idx];
}

function deleteOrder(id) {
  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1) return false;
  orders.splice(idx, 1);
  emitUpdate();
  return true;
}

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  const exists = subscriptions.find(s => s.endpoint === sub.endpoint);
  if (!exists) subscriptions.push(sub);
  res.status(201).json({ message: 'Subscribed' });
});

app.get('/api/orders', (req, res) => res.json(orders));

io.on('connection', (socket) => {
  socket.emit('orders-updated', orders);

  socket.on('new-order', async (data) => {
    const order = createOrder(data);
    socket.broadcast.emit('new-order-notification', {
      orderNumber: order.orderNumber,
      clientName: order.clientName
    });
    await sendPushToAll(
      `New Order #${order.orderNumber}`,
      `Client: ${order.clientName}`
    );
  });

  socket.on('update-order', ({ id, data }) => {
    updateOrder(id, data);
  });

  socket.on('complete-order', (id) => {
    const order = completeOrder(id);
    if (order) {
      sendPushToAll(
        `Order #${order.orderNumber} Completed`,
        `Client: ${order.clientName}`
      );
    }
  });

  socket.on('delete-order', (id) => {
    deleteOrder(id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Order app running on port ${PORT}`);
});
