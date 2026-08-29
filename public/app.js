const socket = io();

let orders = [];

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return new Uint8Array([...rawData].map(c => c.charCodeAt(0)));
}

async function setupPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    const res = await fetch('/api/vapid-public-key');
    const { publicKey } = await res.json();
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(existing)
      });
      return;
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub)
    });
  } catch (err) {
    console.error('Push setup failed:', err);
  }
}

setupPushNotifications();

const tabs = document.querySelectorAll('.tab');
const views = document.querySelectorAll('.view');
const notificationEl = document.getElementById('notification');
const editModal = document.getElementById('editModal');

function showTab(tabId) {
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  views.forEach(v => v.classList.toggle('active', v.id === tabId));
  render();
}

tabs.forEach(tab => tab.addEventListener('click', () => showTab(tab.dataset.tab)));

function showNotification(message) {
  notificationEl.textContent = message;
  notificationEl.classList.remove('hidden');
  setTimeout(() => notificationEl.classList.add('hidden'), 4000);
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString();
}

function createProductRow(name = '', qty = 1, edit = false) {
  const div = document.createElement('div');
  div.className = 'product-row';
  div.innerHTML = `
    <input type="text" class="name" placeholder="Product name" value="${name}" required>
    <input type="number" class="qty" placeholder="Qty" value="${qty}" min="1" required>
    <button type="button" class="remove-product">Remove</button>
  `;
  div.querySelector('.remove-product').addEventListener('click', () => div.remove());
  return div;
}

function addProductRow(container, name = '', qty = 1, edit = false) {
  container.appendChild(createProductRow(name, qty, edit));
}

function getProductsFromContainer(container) {
  const rows = container.querySelectorAll('.product-row');
  const products = [];
  rows.forEach(row => {
    const name = row.querySelector('.name').value.trim();
    const qty = parseInt(row.querySelector('.qty').value, 10);
    if (name) products.push({ name, quantity: qty });
  });
  return products;
}

const productsList = document.getElementById('productsList');
document.getElementById('addProduct').addEventListener('click', () => addProductRow(productsList));
addProductRow(productsList);

const editProductsList = document.getElementById('editProductsList');
document.getElementById('editAddProduct').addEventListener('click', () => addProductRow(editProductsList));

document.getElementById('orderForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const clientName = document.getElementById('clientName').value.trim();
  const products = getProductsFromContainer(productsList);
  if (!clientName || products.length === 0) {
    showNotification('Please enter client name and at least one product.');
    return;
  }
  socket.emit('new-order', { clientName, products });
  e.target.reset();
  productsList.innerHTML = '';
  addProductRow(productsList);
  showNotification('Order submitted.');
  showTab('active');
});

function renderOrderCard(order) {
  const productsHtml = order.products.map(p => `<li>${p.name} x ${p.quantity}</li>`).join('');
  const completedInfo = order.status === 'completed'
    ? `<div class="meta">Completed: ${formatDate(order.completedAt)}</div>`
    : '';
  const actions = order.status === 'active'
    ? `<div class="order-actions">
        <button class="edit" data-id="${order.id}">Edit</button>
        <button class="complete" data-id="${order.id}">Complete</button>
        <button class="delete" data-id="${order.id}">Delete</button>
      </div>`
    : '';

  return `
    <div class="order-card">
      <h3>Order #${order.orderNumber} - ${order.clientName}</h3>
      <div class="meta">Created: ${formatDate(order.createdAt)}</div>
      ${completedInfo}
      <ul>${productsHtml}</ul>
      ${actions}
    </div>
  `;
}

function render() {
  const activeOrders = orders.filter(o => o.status === 'active');
  const historyOrders = orders.filter(o => o.status === 'completed');

  document.getElementById('activeOrders').innerHTML = activeOrders.length
    ? activeOrders.map(renderOrderCard).join('')
    : '<div class="empty">No active orders.</div>';

  document.getElementById('historyOrders').innerHTML = historyOrders.length
    ? historyOrders.map(renderOrderCard).join('')
    : '<div class="empty">No completed orders yet.</div>';

  document.querySelectorAll('.complete').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('complete-order', btn.dataset.id));
  });

  document.querySelectorAll('.edit').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(btn.dataset.id));
  });

  document.querySelectorAll('.delete').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this order?')) socket.emit('delete-order', btn.dataset.id);
    });
  });
}

function openEditModal(id) {
  const order = orders.find(o => o.id === id);
  if (!order) return;
  document.getElementById('editId').value = order.id;
  document.getElementById('editClientName').value = order.clientName;
  editProductsList.innerHTML = '';
  order.products.forEach(p => addProductRow(editProductsList, p.name, p.quantity, true));
  editModal.classList.remove('hidden');
}

document.getElementById('cancelEdit').addEventListener('click', () => {
  editModal.classList.add('hidden');
});

document.getElementById('editForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = document.getElementById('editId').value;
  const clientName = document.getElementById('editClientName').value.trim();
  const products = getProductsFromContainer(editProductsList);
  if (!clientName || products.length === 0) {
    showNotification('Please enter client name and at least one product.');
    return;
  }
  socket.emit('update-order', { id, data: { clientName, products } });
  editModal.classList.add('hidden');
  showNotification('Order updated.');
});

socket.on('orders-updated', (data) => {
  orders = data;
  render();
});

socket.on('new-order-notification', ({ orderNumber, clientName }) => {
  showNotification(`New order #${orderNumber} from ${clientName}`);
});

fetch('/api/orders')
  .then(res => res.json())
  .then(data => {
    orders = data;
    render();
  })
  .catch(() => showNotification('Could not load orders.'));
