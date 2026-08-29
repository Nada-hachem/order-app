const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let orders = [];
let nextOrderNumber = 1;

function emitUpdate() {
  io.emit('orders-updated', orders);
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

io.on('connection', (socket) => {
  socket.emit('orders-updated', orders);

  socket.on('new-order', (data) => {
    const order = createOrder(data);
    socket.broadcast.emit('new-order-notification', {
      orderNumber: order.orderNumber,
      clientName: order.clientName
    });
  });

  socket.on('update-order', ({ id, data }) => {
    updateOrder(id, data);
  });

  socket.on('complete-order', (id) => {
    completeOrder(id);
  });

  socket.on('delete-order', (id) => {
    deleteOrder(id);
  });
});

app.get('/api/orders', (req, res) => res.json(orders));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Order app running on port ${PORT}`);
});
