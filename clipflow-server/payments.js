'use strict';

require('dotenv').config();
const express  = require('express');
const Stripe   = require('stripe');
const db       = require('./db');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  starter:   { priceId: process.env.STRIPE_STARTER_PRICE,   credits: 10,  label: 'Starter — 10 videos',     amount: '$9'  },
  pro:       { priceId: process.env.STRIPE_PRO_PRICE,        credits: 25,  label: 'Pro — 25 videos',         amount: '$19' },
  unlimited: { priceId: process.env.STRIPE_UNLIMITED_PRICE,  credits: 999, label: 'Unlimited — ∞ videos/mo', amount: '$49/mo' },
};

// ── GET /auth/me — get current user from session cookie ────────────────
router.get('/auth/me', (req, res) => {
  const token = req.cookies?.session;
  const email = db.verifySession(token);
  if (!email) return res.json({ user: null });
  const user = db.getUser(email);
  res.json({ user });
});

// ── POST /auth/login — send magic link ─────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });

  db.upsertUser(email); // create if not exists
  const token = db.createLoginToken(email);
  const link  = `${process.env.APP_URL}/auth/verify?token=${token}`;

  let emailSent = false;

  // 1. Try Resend (real email)
  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from:    process.env.RESEND_FROM || 'TikTok Clip Machine <noreply@tiktokclip.com>',
        to:      email,
        subject: '🎬 Tu link de acceso — TikTok Clip Machine',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f0f0f;color:#f0f0f0;border-radius:16px">
            <h1 style="color:#00f2ea;margin:0 0 8px">TikTok ✂️ Clip Machine</h1>
            <p style="color:#888;margin:0 0 24px">Tu link de acceso está listo</p>
            <a href="${link}" style="display:block;background:#00f2ea;color:#000;font-weight:700;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-size:1.1rem;margin-bottom:16px">
              ✅ Iniciar Sesión
            </a>
            <p style="color:#555;font-size:.8rem;margin:0">Este link expira en 15 minutos. Si no lo solicitaste, ignora este email.</p>
          </div>`,
      });
      emailSent = true;
      console.log(`📧 Magic link emailed to ${email}`);
    } catch (e) {
      console.warn('Resend failed:', e.message);
    }
  }

  // 2. Telegram notification to admin (always)
  try {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId        = process.env.TELEGRAM_CHAT_ID;
    if (telegramToken && chatId) {
      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `🔐 Magic link request\n👤 ${email}\n🔗 ${link}\n⏱ Expires in 15 min`,
        }),
      });
    }
  } catch (_) {}

  console.log(`🔐 Magic link for ${email}: ${link}`);

  // Return the link in the response so UI can show it as fallback
  res.json({ ok: true, link, emailSent });
});

// ── GET /auth/verify — verify magic link token ─────────────────────────
router.get('/auth/verify', (req, res) => {
  const { token } = req.query;
  const email = db.verifyLoginToken(token);
  if (!email) {
    return res.redirect('/?error=invalid_token');
  }
  const session = db.createSession(email);
  res.cookie('session', session, {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax',
  });
  res.redirect('/?loggedin=1');
});

// ── POST /auth/logout ──────────────────────────────────────────────────
router.post('/auth/logout', (req, res) => {
  const token = req.cookies?.session;
  if (token) db.deleteSession(token);
  res.clearCookie('session');
  res.json({ ok: true });
});

// ── POST /pay/checkout — create Stripe Checkout session ───────────────
router.post('/pay/checkout', async (req, res) => {
  const { plan } = req.body;
  const token = req.cookies?.session;
  const email = db.verifySession(token);
  if (!email) return res.status(401).json({ error: 'Not logged in' });

  const planData = PLANS[plan];
  if (!planData) return res.status(400).json({ error: 'Invalid plan' });

  const isSubscription = plan === 'unlimited';

  const session = await stripe.checkout.sessions.create({
    mode:               isSubscription ? 'subscription' : 'payment',
    payment_method_types: ['card'],
    customer_email:     email,
    line_items: [{ price: planData.priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/?payment=success&plan=${plan}`,
    cancel_url:  `${process.env.APP_URL}/?payment=cancelled`,
    metadata: { email, plan, credits: planData.credits },
  });

  res.json({ url: session.url });
});

// ── POST /pay/webhook — Stripe webhook ────────────────────────────────
router.post('/pay/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = secret
      ? stripe.webhooks.constructEvent(req.body, sig, secret)
      : JSON.parse(req.body);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent  = event.data.object;
    const email   = intent.metadata?.email;
    const plan    = intent.metadata?.plan;
    const credits = parseInt(intent.metadata?.credits || '0');
    if (email && plan && credits) {
      db.addCredits(email, credits);
      console.log(`✅ PaymentIntent: ${email} → +${credits} credits (${plan})`);
      const tBot = process.env.TELEGRAM_BOT_TOKEN;
      const tChat = process.env.TELEGRAM_CHAT_ID;
      if (tBot && tChat) {
        fetch(`https://api.telegram.org/bot${tBot}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: tChat, text: `💰 NEW PAYMENT!\n👤 ${email}\n📦 ${plan} — +${credits} credits` }),
        }).catch(() => {});
      }
    }
  }

  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object;
    const email    = session.metadata?.email || session.customer_email;
    const plan     = session.metadata?.plan;
    const credits  = parseInt(session.metadata?.credits || '0');

    if (email && plan) {
      if (plan === 'unlimited') {
        db.upsertUser(email, { plan: 'unlimited', credits: 9999 });
        console.log(`✅ ${email} → Unlimited plan activated`);
      } else {
        db.addCredits(email, credits);
        console.log(`✅ ${email} → +${credits} credits (${plan})`);
      }
      // Notify via Telegram
      const tBot  = process.env.TELEGRAM_BOT_TOKEN;
      const tChat = process.env.TELEGRAM_CHAT_ID;
      const planNames = { starter: 'Starter $9', pro: 'Pro $19', unlimited: 'Unlimited $49/mo' };
      if (tBot && tChat) {
        fetch(`https://api.telegram.org/bot${tBot}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: tChat,
            text: `💰 NEW PAYMENT!\n👤 ${email}\n📦 ${planNames[plan] || plan}\n🎬 +${credits} credits`,
          }),
        }).catch(() => {});
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub   = event.data.object;
    const email = sub.metadata?.email;
    if (email) {
      db.upsertUser(email, { plan: 'free', credits: 0 });
      console.log(`❌ ${email} → Unlimited cancelled`);
    }
  }

  res.json({ received: true });
});

// ── POST /pay/intent — create PaymentIntent for embedded form ──────────
router.post('/pay/intent', async (req, res) => {
  const { plan } = req.body;
  const token = req.cookies?.session;
  const email = db.verifySession(token);
  if (!email) return res.status(401).json({ error: 'Not logged in' });

  const planData = PLANS[plan];
  if (!planData) return res.status(400).json({ error: 'Invalid plan' });

  try {
    if (plan === 'unlimited') {
      // Subscription needs SetupIntent + redirect — use Checkout for this one
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        customer_email: email,
        line_items: [{ price: planData.priceId, quantity: 1 }],
        success_url: `${process.env.APP_URL}/?payment=success&plan=${plan}`,
        cancel_url:  `${process.env.APP_URL}/?payment=cancelled`,
        metadata: { email, plan, credits: planData.credits },
      });
      return res.json({ checkoutUrl: session.url });
    }

    // One-time payment — embedded PaymentIntent
    const intent = await stripe.paymentIntents.create({
      amount:   planData.amount_cents || (plan === 'starter' ? 900 : 1900),
      currency: 'usd',
      receipt_email: email,
      metadata: { email, plan, credits: planData.credits },
    });

    res.json({
      clientSecret:      intent.client_secret,
      publishableKey:    process.env.STRIPE_PUBLISHABLE_KEY,
      plan,
      planLabel:         planData.label,
      amount:            planData.amount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /pay/plans — return plans for frontend ─────────────────────────
router.get('/pay/plans', (_req, res) => {
  res.json({ plans: PLANS });
});

module.exports = router;
