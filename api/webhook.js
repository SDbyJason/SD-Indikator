// ═══════════════════════════════════════════════════════
//  APEX — Stripe Webhook (Vercel Serverless Function)
//  Datei: api/webhook.js
// ═══════════════════════════════════════════════════════

const stripe = require('stripe');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

function getDB() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const stripeClient  = stripe(process.env.STRIPE_SECRET_KEY);
  const sig           = req.headers['stripe-signature'];

  let event;
  try {
    event = stripeClient.webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const db = getDB();

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const uid = session.client_reference_id;
        if (!uid) break;
        await db.collection('apexUsers').doc(uid).update({
          plan:                'pro',
          subscriptionActive:  true,
          stripeCustomerId:    session.customer || null,
          stripeSessionId:     session.id,
          planActivatedAt:     FieldValue.serverTimestamp(),
          stripeSubscriptionId: session.subscription || null,
        });
        console.log(`User ${uid} upgraded to PRO`);
        break;
      }

      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        if (inv.billing_reason !== 'subscription_cycle') break;
        const snap = await db.collection('apexUsers')
          .where('stripeCustomerId', '==', inv.customer).limit(1).get();
        if (!snap.empty) await snap.docs[0].ref.update({
          plan: 'pro', subscriptionActive: true,
          lastRenewalAt: FieldValue.serverTimestamp(),
        });
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const snap = await db.collection('apexUsers')
          .where('stripeCustomerId', '==', inv.customer).limit(1).get();
        if (!snap.empty) await snap.docs[0].ref.update({
          subscriptionActive: false,
          paymentFailedAt: FieldValue.serverTimestamp(),
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const snap = await db.collection('apexUsers')
          .where('stripeCustomerId', '==', sub.customer).limit(1).get();
        if (!snap.empty) await snap.docs[0].ref.update({
          plan: 'free', subscriptionActive: false,
          subscriptionCancelledAt: FieldValue.serverTimestamp(),
        });
        break;
      }
    }
  } catch (err) {
    console.error(err);
    return res.status(500).end();
  }

  res.json({ received: true });
};

module.exports.config = { api: { bodyParser: false } };
