const express = require("express");

const app = express();

app.use(express.json({ limit: "10mb" }));

function findEmailsDeep(value) {
  const found = new Set();

  const visit = (v) => {
    if (v == null) return;

    if (typeof v === "string") {
      const matches = v.match(
        /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
      );
      if (matches) matches.forEach((m) => found.add(m));
      return;
    }

    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }

    if (typeof v === "object") {
      for (const k of Object.keys(v)) visit(v[k]);
    }
  };

  visit(value);
  return Array.from(found);
}

async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const baseUrl = process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET environment variables."
    );
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal token error (${res.status}): ${text}`);
  }

  const data = await res.json();
  return { accessToken: data.access_token, baseUrl };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function tierToAmount(tier) {
  const map = {
    pro: "19.99",
    legend: "35.00",
    basic: "1.00",  // $1 Basic Pro tier
  };
  return map[String(tier || "").toLowerCase()] || "19.99";
}

function safeStr(v) {
  if (typeof v !== "string") return "";
  return v.slice(0, 127);
}

function extractCustomIdFromWebhookEvent(event) {
  return (
    event?.resource?.custom_id ||
    event?.resource?.supplementary_data?.related_ids?.custom_id ||
    null
  );
}

function parseCustomId(customId) {
  if (!customId) return null;
  const parts = String(customId).split("|");
  const email = parts[0] || null;
  const tier = parts[1] || null;
  return { email, tier };
}

async function updateTierInTikHubCloud(email, tier, eventId) {
  const cloudApiUrl = process.env.TIKHUB_CLOUD_API_URL;
  const adminKey = process.env.TIKHUB_CLOUD_ADMIN_KEY;

  if (!cloudApiUrl) {
    throw new Error('Missing TIKHUB_CLOUD_API_URL');
  }
  if (!adminKey) {
    throw new Error('Missing TIKHUB_CLOUD_ADMIN_KEY');
  }

  // First update the subscription in the database
  const res = await fetch(`${cloudApiUrl}/admin/set-tier-by-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': adminKey,
    },
    body: JSON.stringify({ email, tier, eventId }),
  });

  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.toLowerCase().includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : await res.text().catch(() => null);

  if (!res.ok) {
    throw new Error(
      `TikHub Cloud API error (${res.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`
    );
  }

  // Now trigger WebSocket broadcast for real-time update
  try {
    const broadcastRes = await fetch(`${cloudApiUrl}/admin/broadcast-subscription-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': adminKey,
      },
      body: JSON.stringify({ email, tier, eventId }),
    });
    
    if (broadcastRes.ok) {
      console.log(`✅ WebSocket broadcast triggered for ${email}: ${tier}`);
    } else {
      console.warn(`⚠️ WebSocket broadcast failed for ${email}: ${broadcastRes.status}`);
    }
  } catch (broadcastError) {
    console.warn(`⚠️ Failed to trigger WebSocket broadcast:`, broadcastError.message);
  }

  return data;
}

async function notifyDiscordPayment({ tier, email, activatedAt, transactionId }) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const safeTier = String(tier || '').toLowerCase();
  const prettyTier = safeTier ? safeTier.charAt(0).toUpperCase() + safeTier.slice(1) : '';
  const when = activatedAt || new Date().toLocaleString();

  const content =
    `Payment received ✅\n\n` +
    `Activated: ${prettyTier} Tier\n` +
    `Account: ${email || 'N/A'}\n` +
    `Activated at: ${when}\n` +
    `PayPal Transaction ID: ${transactionId || 'N/A'}`;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (e) {
    console.error('Discord webhook notify failed:', e?.message || e);
  }
}

app.get("/", (req, res) => {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  if (!clientId) {
    res.status(500).send(
      "Missing PAYPAL_CLIENT_ID env var. Set it and restart the server."
    );
    return;
  }

  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TikHub Subscription</title>
    <style>
      .discord-float {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 1000;
        background: #202437;
        border: 1px solid #2f3445;
        border-radius: 10px;
        width: 50px;
        height: 50px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 3px 12px rgba(0, 0, 0, 0.22);
        cursor: pointer;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
        border: none;
        font-size: 24px;
      }
      .discord-float:hover {
        transform: translateY(-1px);
        box-shadow: 0 5px 16px rgba(88, 101, 242, 0.35);
      }
      .discord-float:active {
        transform: none;
        box-shadow: 0 3px 12px rgba(0, 0, 0, 0.22);
      }
      :root {
        --bg: #0b1020;
        --card: rgba(255,255,255,.06);
        --card2: rgba(255,255,255,.08);
        --text: #e9ecf5;
        --muted: rgba(233,236,245,.75);
        --border: rgba(255,255,255,.12);
        --accent: #7c3aed;
        --accent2: #22d3ee;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        background: radial-gradient(1200px 800px at 20% 10%, rgba(124,58,237,.35), transparent 55%),
                    radial-gradient(1000px 700px at 80% 0%, rgba(34,211,238,.25), transparent 55%),
                    var(--bg);
        color: var(--text);
      }
      .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 18px 60px; }
      .header { display: flex; gap: 16px; align-items: center; justify-content: space-between; margin-bottom: 18px; }
      .brand { display: flex; gap: 14px; align-items: center; }
      .logo {
        width: 52px; height: 52px; border-radius: 18px;
        background: rgba(255,255,255,.06);
        border: 1px solid var(--border);
        display: grid; place-items: center;
        overflow: hidden;
        box-shadow: 0 12px 30px rgba(0,0,0,.25);
      }
      .logo img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .title { line-height: 1.1; }
      .title h1 { margin: 0; font-size: 18px; letter-spacing: .2px; }
      .title p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
      .pill {
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: 999px;
        background: rgba(255,255,255,.04);
        color: var(--muted);
        font-size: 12px;
      }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
      @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 18px;
        backdrop-filter: blur(10px);
      }
      .card h2 { margin: 0 0 8px; font-size: 16px; }
      .card p { margin: 0 0 14px; color: var(--muted); font-size: 13px; }
      label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
      input {
        width: 100%;
        padding: 12px 12px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: rgba(0,0,0,.18);
        color: var(--text);
        outline: none;
      }
      input:focus { border-color: rgba(124,58,237,.65); box-shadow: 0 0 0 4px rgba(124,58,237,.18); }
      .inputError { border-color: rgba(244,63,94,.8) !important; box-shadow: 0 0 0 4px rgba(244,63,94,.14) !important; }
      .fieldError { margin-top: 8px; color: rgba(254,202,202,.95); font-size: 12px; display: none; }
      .plans { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
      @media (max-width: 520px) { .plans { grid-template-columns: 1fr; } }
      .plan {
        cursor: pointer;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,.04);
        padding: 14px;
        transition: transform .12s ease, border-color .12s ease, background .12s ease;
      }
      .plan:hover { transform: translateY(-1px); border-color: rgba(255,255,255,.22); background: rgba(255,255,255,.06); }
      .plan.selected { border-color: rgba(34,211,238,.6); background: rgba(34,211,238,.08); }
      .planTop { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
      .planName { font-weight: 700; }
      .price { font-weight: 800; }
      .per { font-size: 12px; color: var(--muted); margin-left: 6px; font-weight: 600; }
      .features { margin: 10px 0 0; padding-left: 18px; color: var(--muted); font-size: 12px; }
      .features li { margin: 6px 0; }
      .side h3 { margin: 0 0 8px; font-size: 14px; }
      .summaryRow { display: flex; justify-content: space-between; color: var(--muted); font-size: 13px; margin: 8px 0; }
      .summaryRow strong { color: var(--text); }
      .divider { height: 1px; background: rgba(255,255,255,.10); margin: 12px 0; }
      .ctaHint { color: var(--muted); font-size: 12px; margin-top: 10px; line-height: 1.4; }
      #paypal-button-container { margin-top: 14px; }
      .modalOverlay {
        position: fixed; inset: 0; background: rgba(11,15,25,.85); backdrop-filter: blur(6px);
        z-index: 9999; display: none; align-items: center; justify-content: center;
        animation: fadeIn 0.25s ease;
      }
      .modal {
        background: var(--card); border: 1px solid var(--border); border-radius: 20px;
        padding: 28px 24px; max-width: 420px; width: 90vw;
        box-shadow: 0 20px 60px rgba(0,0,0,.4);
        animation: slideUp 0.3s ease;
        color: var(--text);
      }
      .modal h2 { margin: 0 0 16px; font-size: 20px; font-weight: 700; color: var(--text); }
      .modal p { margin: 0 0 20px; color: rgba(233,236,245,.88); font-size: 14px; line-height: 1.5; }
      .modal .icon {
        width: 64px; height: 64px; margin: 0 auto 20px; display: block;
        border-radius: 16px; background: var(--accent); padding: 12px;
      }
      .modal .timer {
        font-size: 13px; font-weight: 700; color: #ffffff;
        background: var(--accent); border-radius: 10px; padding: 8px 10px;
        margin: 16px 0; text-align: center;
        animation: pulse 1s infinite;
      }
      .modal .timer span { color: #ffffff; }
      .modal .closeBtn {
        background: var(--accent); color: white; border: none; border-radius: 10px;
        padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer;
        width: 100%; margin-top: 12px;
        transition: opacity .2s ease;
      }
      .modal .secondaryBtn {
        background: rgba(255,255,255,.08);
        color: var(--text);
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 10px;
        padding: 10px 18px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        width: 100%;
        margin-top: 10px;
        transition: background .2s ease, border-color .2s ease;
      }
      .modal .secondaryBtn:hover { background: rgba(255,255,255,.10); border-color: rgba(255,255,255,.22); }
      .modal .closeBtn:hover { opacity: .85; }
      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes slideUp { from { transform: translateY(30px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
    </style>
  </head>
  <body>
    <button class="discord-float" onclick="openDiscordInvite()" title="Join our Discord server">
      <span style="display: flex; align-items: center; justify-content: center; background: #5865F2; border-radius: 8px; width: 30px; height: 30px;">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="#FFFFFF" d="M20.317 4.369A19.791 19.791 0 0 0 16.558 3a14.221 14.221 0 0 0-.671 1.361 18.626 18.626 0 0 0-5.773 0A14.134 14.134 0 0 0 9.444 3a19.736 19.736 0 0 0-3.76 1.379c-2.37 3.443-3.02 6.8-2.693 10.113A19.912 19.912 0 0 0 8.27 17.45a14.578 14.578 0 0 0 1.2-1.946 12.9 12.9 0 0 1-1.889-.9c.16-.115.316-.234.467-.356 3.637 1.696 7.57 1.696 11.183 0 .152.123.309.242.467.356-.6.364-1.237.664-1.888.9.352.682.763 1.332 1.2 1.946a19.8 19.8 0 0 0 5.277-2.958c.433-4.476-.76-7.807-2.97-10.123ZM8.62 13.773c-1.092 0-1.988-1.006-1.988-2.248s.87-2.248 1.988-2.248c.113 0 2 .986 2 2.248 0 1.242-.882 2.248-2 2.248Zm6.76 0c-1.093 0-1.989-1.006-1.989-2.248s.87-2.248 1.989-2.248c1.13 0 2 .986 2 2.248-.01 1.242-.882 2.248-2 2.248Z"/>
        </svg>
      </span>
    </button>
    <div class="wrap">
      <div class="header">
        <div class="brand">
          <div class="logo"><img src="https://i.imgur.com/KK7C8AU.png" alt="TikHub" /></div>
          <div class="title">
            <h1>TikHub Subscription</h1>
            <p>Upgrade instantly. Your account tier updates automatically after payment.</p>
          </div>
        </div>
        <div class="pill">Secure checkout powered by PayPal</div>
      </div>

      <div class="grid">
        <div class="card">
          <h2>Choose your plan</h2>
          <p>Enter the email you use to login in the TikHub app, then choose a plan.</p>

          <label>Account email</label>
          <input id="appEmail" type="email" placeholder="you@example.com" autocomplete="email" />
          <div id="emailError" class="fieldError">Please enter your account email to continue.</div>

          <div class="plans">
            <div class="plan" data-tier="pro" data-price="19.99">
              <div class="planTop">
                <div class="planName">Pro</div>
                <div class="price">$19.99<span class="per">USD</span></div>
              </div>
              <ul class="features">
                <li>Everything in Basic Pro</li>
                <li>Priority access to more games</li>
                <li>Enhanced features and limits</li>
              </ul>
            </div>
            <div class="plan" data-tier="legend" data-price="35.00">
              <div class="planTop">
                <div class="planName">Legend</div>
                <div class="price">$35.00<span class="per">USD</span></div>
              </div>
              <ul class="features">
                <li>Everything in Pro</li>
                <li>Legend tier unlocks + highest limits</li>
                <li>Ultimate automation and white-label options</li>
              </ul>
            </div>
          </div>

          <input id="tier" type="hidden" value="pro" />

          <div class="ctaHint">After payment, it can take a few minutes for your tier to update. Please restart the Tiktoearn app to refresh your access. If it still doesn’t update after some time, message us in the Discord server.</div>
          <div class="ctaHint" style="margin-top: 12px; padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(255,215,0,.35); background: rgba(255,215,0,.08); color: rgba(255,223,0,.95);">
            💡 <strong>Alternative Payment Methods:</strong> If you'd like to use a different payment method (crypto, bank transfer, etc.), join our Discord server and contact support.
          </div>

          <div id="paidNotice" class="ctaHint" style="display:none; margin-top: 12px; padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(34,211,238,.35); background: rgba(34,211,238,.08); color: rgba(233,236,245,.95);">
            Payment received. Your tier will update shortly.
          </div>
        </div>

        <div class="card side">
          <h3>Order summary</h3>
          <div class="summaryRow"><span>Plan</span><strong id="summaryPlan">Pro</strong></div>
          <div class="summaryRow"><span>Total</span><strong id="summaryTotal">$19.99 USD</strong></div>
          <div class="divider"></div>
          <div id="paypal-button-container"></div>
          <div class="ctaHint">You can pay with PayPal balance or card (PayPal checkout).</div>
          <div class="ctaHint" style="margin-top: 12px; padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(255,215,0,.35); background: rgba(255,215,0,.08); color: rgba(255,223,0,.95);">
            💡 <strong>Alternative Payment Methods:</strong> If you'd like to use a different payment method (crypto, bank transfer, etc.), join our Discord server and contact support.
          </div>
        </div>
      </div>
    </div>

    <!-- Modal overlay -->
    <div id="paymentModal" class="modalOverlay">
      <div class="modal">
        <div class="icon">✅</div>
        <h2>Payment Successful</h2>
        <p>Your tier will update shortly. Please restart the Tiktoearn app to refresh your access.</p>
        <p>If it still doesn’t update after some time, message us in the Discord server.</p>
        <div class="timer">This popup closes in <span id="modalCountdown">10</span> seconds</div>
        <button class="secondaryBtn" onclick="openDiscordInvite()">Join Discord server</button>
        <button class="closeBtn" onclick="closePaymentModal()">Close</button>
      </div>
    </div>

    <script src="https://www.paypal.com/sdk/js?client-id=${clientId}&currency=USD&intent=capture&components=buttons&disable-funding=paylater"></script>
    <script>
      const tierEl = document.getElementById('tier');
      const summaryPlanEl = document.getElementById('summaryPlan');
      const summaryTotalEl = document.getElementById('summaryTotal');
      const paidNoticeEl = document.getElementById('paidNotice');
      const emailEl = document.getElementById('appEmail');
      const emailErrorEl = document.getElementById('emailError');

      const postPaymentNote = "After payment, it can take a few minutes for your tier to update. Please restart the Tiktoearn app to refresh your access. If it still doesn’t update after some time, message us in the Discord server.";

      function showPaymentModal() {
        const modal = document.getElementById('paymentModal');
        const countdownEl = document.getElementById('modalCountdown');
        let seconds = 10;
        modal.style.display = 'flex';
        const interval = setInterval(() => {
          seconds--;
          if (countdownEl) countdownEl.textContent = seconds;
          if (seconds <= 0) {
            clearInterval(interval);
            closePaymentModal();
          }
        }, 1000);
      }

      function closePaymentModal() {
        const modal = document.getElementById('paymentModal');
        if (modal) modal.style.display = 'none';
      }

      function openDiscordInvite() {
        window.open('https://discord.com/invite/9rPAVZGMV2', '_blank', 'noopener,noreferrer');
      }

      function selectPlan(planEl) {
        document.querySelectorAll('.plan').forEach((el) => el.classList.remove('selected'));
        planEl.classList.add('selected');
        const tier = planEl.getAttribute('data-tier');
        const price = planEl.getAttribute('data-price');
        tierEl.value = tier;
        summaryPlanEl.textContent = tier === 'legend' ? 'Legend' : 'Pro';
        summaryTotalEl.textContent = '$' + price + ' USD';
      }

      function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
      }

      function setEmailError(message) {
        if (!emailEl || !emailErrorEl) return;
        if (message) {
          emailEl.classList.add('inputError');
          emailErrorEl.textContent = message;
          emailErrorEl.style.display = 'block';
        } else {
          emailEl.classList.remove('inputError');
          emailErrorEl.style.display = 'none';
        }
      }

      document.querySelectorAll('.plan').forEach((el) => {
        el.addEventListener('click', () => selectPlan(el));
      });

      paypal.Buttons({
        onInit: (data, actions) => {
          const update = () => {
            const emailOk = isValidEmail(emailEl?.value || '');
            if (emailOk) {
              setEmailError('');
              actions.enable();
            } else {
              actions.disable();
            }
          };

          update();

          if (emailEl) {
            emailEl.addEventListener('input', update);
            emailEl.addEventListener('blur', () => {
              if (!isValidEmail(emailEl.value || '')) {
                setEmailError('Please enter your account email to continue.');
              } else {
                setEmailError('');
              }
            });
          }
          
          actions.disable(); // Initially disable until user enters email
          
          return actions;
        },
        onClick: () => {
          const email = (emailEl?.value || '').trim();
          if (!isValidEmail(email)) {
            setEmailError('Please enter your account email to continue.');
            emailEl?.focus();
            emailEl?.classList.add('inputError');
            return false; // Prevent the action
          }
        },
        createOrder: async () => {
          const email = (emailEl?.value || '').trim();
          const tier = tierEl.value;
          if (!isValidEmail(email)) {
            setEmailError('Please enter your account email to continue.');
            emailEl?.focus();
            // Show visual indication that email is required
            emailEl?.classList.add('inputError');
            throw new Error('Missing email');
          }

          const res = await fetch('/api/paypal/create-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, tier })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || 'Failed to create order');
          return data.id;
        },
        onApprove: async (data) => {
          const res = await fetch('/api/paypal/capture-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: data.orderID })
          });
          const capture = await res.json();
          if (!res.ok) throw new Error(capture?.error || 'Failed to capture order');

          if (paidNoticeEl) paidNoticeEl.style.display = 'block';
          showPaymentModal();
        },

        onError: (err) => {
          console.error('PayPal error:', err);
        }
      }).render('#paypal-button-container');
    </script>
  </body>
</html>`);
});

app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    const tier = String(req.body?.tier || "pro").trim();

    if (!isValidEmail(email)) {
      res.status(400).json({ error: "Invalid email." });
      return;
    }

    const amount = tierToAmount(tier);
    const customId = safeStr(`${email}|${tier}`);
    const invoiceId = safeStr(`tiktok-${tier}-${Date.now()}`);

    const { accessToken, baseUrl } = await getPayPalAccessToken();

    const orderRes = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: {
              currency_code: "USD",
              value: amount,
            },
            custom_id: customId,
            invoice_id: invoiceId,
            description: `TikTok Games App Tier: ${tier}`,
          },
        ],
      }),
    });

    const orderData = await orderRes.json();
    if (!orderRes.ok) {
      res.status(orderRes.status).json({ error: orderData });
      return;
    }

    res.json({ id: orderData.id });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "").trim();
    if (!orderId) {
      res.status(400).json({ error: "Missing orderId." });
      return;
    }

    const { accessToken, baseUrl } = await getPayPalAccessToken();

    const captureRes = await fetch(
      `${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const captureData = await captureRes.json();
    if (!captureRes.ok) {
      res.status(captureRes.status).json({ error: captureData });
      return;
    }

    try {
      const pu = captureData?.purchase_units?.[0];
      const customId = pu?.custom_id || null;
      const parsed = parseCustomId(customId);
      const transactionId =
        pu?.payments?.captures?.[0]?.id ||
        captureData?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
        orderId;

      if (parsed?.email && parsed?.tier) {
        await notifyDiscordPayment({
          tier: parsed.tier,
          email: parsed.email,
          activatedAt: new Date().toLocaleString(),
          transactionId,
        });
      }
    } catch (e) {
      console.error('Failed to notify Discord from capture:', e?.message || e);
    }

    res.json({ status: captureData.status, capture: captureData });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.get("/paypal-webhook", (req, res) => {
  res.status(200).send("OK");
});

app.post("/paypal-webhook", (req, res) => {
  console.log("\n  ===== PAYPAL WEBHOOK RECEIVED =====");
  console.log("⏰ Time:", new Date().toLocaleString());

  const event = req.body;

  console.log("✅ Event Type:", event?.event_type);
  console.log("🧾 Webhook Event ID:", event?.id);

  // Common places (may be null depending on event/flow)
  const captureAmount = event?.resource?.amount?.value;
  const currency = event?.resource?.amount?.currency_code;
  console.log("💰 Amount:", captureAmount, currency);

  // Try to find payer email (often missing in simulator)
  const payerEmail =
    event?.resource?.payer?.email_address ||
    event?.resource?.payer?.email ||
    null;
  console.log("📧 Payer email field:", payerEmail);

  // Deep-scan for ANY email strings (useful if your "notes" field is included somewhere)
  const emailsFound = findEmailsDeep(event);
  console.log("🔎 Emails found anywhere in payload:", emailsFound);

  const customId = extractCustomIdFromWebhookEvent(event);
  const parsedCustomId = parseCustomId(customId);
  console.log("🏷️ custom_id:", customId);
  console.log("🎯 Parsed custom_id:", parsedCustomId);

  // Tier activation logic
  if (parsedCustomId && parsedCustomId.email && parsedCustomId.tier) {
    let { email, tier } = parsedCustomId;
    
    // Map "basic" tier (for $1 Basic Pro) to "pro" tier as per marketing strategy
    if (tier.toLowerCase() === 'basic') {
      console.log(`🔄 Converting tier from "basic" to "pro" for ${email}`);
      tier = 'pro';
    }
    
    console.log(`🚀 Activating tier: ${email} -> ${tier}`);

    const transactionId =
      event?.resource?.id ||
      event?.resource?.supplementary_data?.related_ids?.order_id ||
      event?.resource?.supplementary_data?.related_ids?.capture_id ||
      event?.id ||
      null;

    notifyDiscordPayment({
      tier,
      email,
      activatedAt: new Date().toLocaleString(),
      transactionId,
    }).catch(() => {});

    updateTierInTikHubCloud(email, tier, event?.id)
      .then(() => {
        console.log(`✅ TikHub Cloud tier updated for ${email}: ${tier}`);
      })
      .catch((err) => {
        console.error(
          `❌ Failed to update TikHub Cloud tier for ${email}:`,
          err?.message || err
        );
      });

    // For now, we'll just log the activation
    console.log(`✅ Tier activated for ${email}: ${tier}`);
  }

  res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🌐 Open http://localhost:${PORT} in your browser to test the PayPal button.`);
});