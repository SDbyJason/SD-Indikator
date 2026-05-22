// ═══════════════════════════════════════════════════════
//  APEX — Stripe Webhook Cloud Function
//  Handles: checkout.session.completed
//           customer.subscription.deleted
//           invoice.payment_succeeded
//           invoice.payment_failed
// ═══════════════════════════════════════════════════════

const functions = require("firebase-functions");
const admin     = require("firebase-admin");
const stripe    = require("stripe");

admin.initializeApp();
const db = admin.firestore();

// ─── WEBHOOK HANDLER ───────────────────────────────────
// Triggered by Stripe — verifies signature, updates Firestore
exports.stripeWebhook = functions
  .region("europe-west1")           // Change to "us-central1" if you prefer US
  .runWith({ secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] })
  .https.onRequest(async (req, res) => {

    const stripeClient     = stripe(process.env.STRIPE_SECRET_KEY);
    const webhookSecret    = process.env.STRIPE_WEBHOOK_SECRET;
    const sig              = req.headers["stripe-signature"];

    let event;
    try {
      // Verify webhook signature — req.rawBody is available in Cloud Functions
      event = stripeClient.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    } catch (err) {
      console.error("⚠ Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`✓ Stripe event: ${event.type}`);

    try {
      switch (event.type) {

        // ── CHECKOUT COMPLETED (Payment Link or Hosted Checkout) ──
        case "checkout.session.completed": {
          const session = event.data.object;
          // client_reference_id = Firebase UID (set in the payment link or checkout)
          const uid = session.client_reference_id;
          if (!uid) {
            console.warn("No client_reference_id in session — cannot map to user.");
            break;
          }
          const isSubscription = session.mode === "subscription";
          const updateData = {
            plan:               "pro",
            subscriptionActive: true,
            stripeCustomerId:   session.customer || null,
            stripeSessionId:    session.id,
            subscriptionMode:   isSubscription ? "subscription" : "one_time",
            planActivatedAt:    admin.firestore.FieldValue.serverTimestamp(),
          };
          if (isSubscription) {
            updateData.stripeSubscriptionId = session.subscription || null;
          }
          await db.collection("apexUsers").doc(uid).update(updateData);
          console.log(`✓ User ${uid} upgraded to PRO`);
          break;
        }

        // ── SUBSCRIPTION RENEWAL ──
        case "invoice.payment_succeeded": {
          const invoice = event.data.object;
          if (invoice.billing_reason !== "subscription_cycle") break;
          // Find user by stripeCustomerId
          const snap = await db.collection("apexUsers")
            .where("stripeCustomerId", "==", invoice.customer)
            .limit(1).get();
          if (snap.empty) {
            console.warn(`No user found for customer ${invoice.customer}`);
            break;
          }
          await snap.docs[0].ref.update({
            plan:               "pro",
            subscriptionActive: true,
            lastRenewalAt:      admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`✓ Subscription renewed for customer ${invoice.customer}`);
          break;
        }

        // ── PAYMENT FAILED ──
        case "invoice.payment_failed": {
          const invoice = event.data.object;
          const snap = await db.collection("apexUsers")
            .where("stripeCustomerId", "==", invoice.customer)
            .limit(1).get();
          if (snap.empty) break;
          await snap.docs[0].ref.update({
            subscriptionActive: false,
            paymentFailedAt:    admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`⚠ Payment failed for customer ${invoice.customer}`);
          break;
        }

        // ── SUBSCRIPTION CANCELLED ──
        case "customer.subscription.deleted": {
          const sub = event.data.object;
          const snap = await db.collection("apexUsers")
            .where("stripeCustomerId", "==", sub.customer)
            .limit(1).get();
          if (snap.empty) break;
          await snap.docs[0].ref.update({
            plan:               "free",
            subscriptionActive: false,
            subscriptionCancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`✓ Subscription cancelled for customer ${sub.customer}`);
          break;
        }

        default:
          console.log(`Unhandled event type: ${event.type}`);
      }
    } catch (err) {
      console.error("Error processing webhook:", err);
      return res.status(500).send("Internal error");
    }

    res.json({ received: true });
  });
