import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT || 4242);
const root = path.dirname(fileURLToPath(import.meta.url));
const plans = {
  '3m': { name: '3 months', amount: 1388, compareAt: 1444, paymentUrl: process.env.ABA_PAY_LINK_3M || 'https://pay.ababank.com/oRF8/m1rtp7ub' },
  '6m': { name: '6 months', amount: 1777, compareAt: 2222, paymentUrl: process.env.ABA_PAY_LINK_6M || 'https://pay.ababank.com/oRF8/d75esh3o' },
  '12m': { name: '12 months', amount: 2999, compareAt: 4888, paymentUrl: process.env.ABA_PAY_LINK_12M || 'https://pay.ababank.com/oRF8/3c9wynb7' },
};
const orders = new Map();
const orderDirectory = path.join(root, 'data');
const orderFile = path.join(orderDirectory, 'orders.json');
let orderWrites = Promise.resolve();

await mkdir(orderDirectory, { recursive: true });
try {
  const savedOrders = JSON.parse(await readFile(orderFile, 'utf8'));
  for (const order of savedOrders) {
    if (order.orderId && order.planId in plans) orders.set(order.orderId, order);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function persistOrders() {
  orderWrites = orderWrites.then(async () => {
    const temporaryFile = `${orderFile}.tmp`;
    await writeFile(temporaryFile, JSON.stringify([...orders.values()], null, 2), { mode: 0o600 });
    await rename(temporaryFile, orderFile);
  });
  return orderWrites;
}

app.use('/vendor', express.static(path.join(root, 'node_modules/three/build'), { maxAge: '1d' }));

app.get('/api/telegram/profile', async (req, res) => {
  const rawUsername = String(req.query.username || '').trim().replace(/^@+/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(rawUsername)) {
    return res.status(400).json({ error: 'Enter a valid Telegram username (5–32 letters, numbers, or underscores).' });
  }

  try {
    const response = await fetch(`https://thlockup.vercel.app/api/v1/telegram/profile?username=${encodeURIComponent(`@${rawUsername}`)}`, {
      headers: { accept: '*/*' },
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok || !result.success || !result.data) {
      return res.status(response.status >= 400 ? response.status : 404).json({ error: result.error || 'That profile could not be found.' });
    }
    const { id, username, first_name, last_name, display_name, verified, premium, bot, restricted, deleted, photo_url, photo_big_url, bio } = result.data;
    return res.json({ profile: { id, username, firstName: first_name, lastName: last_name, displayName: display_name, verified, premium, bot, restricted, deleted, photoUrl: photo_big_url || photo_url, bio } });
  } catch (error) {
    console.error('Telegram lookup failed:', error.message);
    return res.status(502).json({ error: 'Telegram lookup is temporarily unavailable. Please try again.' });
  }
});

app.post('/api/aba/payment-link', express.json(), async (req, res) => {
  const { planId, username } = req.body || {};
  const plan = plans[planId];
  const cleanUsername = String(username || '').trim().replace(/^@+/, '');
  if (!plan || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(cleanUsername)) {
    return res.status(400).json({ error: 'Choose a plan and look up a valid Telegram username.' });
  }
  const order = {
    orderId: randomUUID(),
    username: cleanUsername,
    planId,
    amount: (plan.amount / 100).toFixed(2),
    currency: 'USD',
    paymentClaimSent: false,
    createdAt: new Date().toISOString(),
  };
  orders.set(order.orderId, order);
  try {
    await persistOrders();
    return res.json({
      paymentUrl: plan.paymentUrl,
      orderId: order.orderId,
      username: cleanUsername,
      plan: plan.name,
      amount: order.amount,
    });
  } catch (error) {
    orders.delete(order.orderId);
    console.error('Could not save pending ABA order:', error.message);
    return res.status(500).json({ error: 'Could not save the order. Please try again.' });
  }
});

app.post('/api/aba/payment-claim', express.json(), async (req, res) => {
  const orderId = String(req.body?.orderId || '');
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found. Please open checkout again.' });
  if (order.paymentClaimSent) return res.json({ notified: true, alreadySent: true });
  if (order.paymentClaimSending) return res.status(409).json({ error: 'Your payment claim is already being sent.' });
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ORDER_CHAT_ID
    || process.env.TELEGRAM_BOT_TOKEN.startsWith('replace_with_')
    || process.env.TELEGRAM_ORDER_CHAT_ID.startsWith('replace_with_')) {
    return res.status(503).json({ error: 'Telegram order alerts are not configured yet.' });
  }

  order.paymentClaimSending = true;
  const message = [
    'SALSTORE · PAYMENT CLAIMED — VERIFY IN ABA',
    `Telegram: @${order.username}`,
    `Plan: ${plans[order.planId].name}`,
    `Amount: $${order.amount} ${order.currency}`,
    `Order reference: ${order.orderId}`,
    'Status: Customer says they paid. NOT VERIFIED.',
  ].join('\n');
  try {
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_ORDER_CHAT_ID, text: message }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error('Telegram did not accept the order alert.');
    order.paymentClaimSent = true;
    order.paymentClaimedAt = new Date().toISOString();
    await persistOrders();
    return res.json({ notified: true, verified: false, orderId: order.orderId });
  } catch (error) {
    console.error('Telegram payment claim alert failed:', error.message);
    return res.status(502).json({ error: 'Could not notify the SalStore bot. Please try again.' });
  } finally {
    order.paymentClaimSending = false;
  }
});

app.use(express.static(path.join(root, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(root, 'public/index.html')));

app.listen(port, () => console.info(`SalStore running at http://localhost:${port}`));
