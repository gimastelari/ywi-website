const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const dotenv = require("dotenv");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// =====================
// CONFIG — swap this once the YWI site domain is live
// =====================
const SITE_URL = process.env.SITE_URL || "https://theyoungwomensinitiative.com";

// =====================
// MIDDLEWARE
// =====================
app.use(cors());
app.use(express.json());

// =====================
// DATABASE (SQLite)
// =====================
let db;

(async () => {
  db = await open({
    filename: "./registrations.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("Database ready");
})();

// =====================
// HEALTH CHECK
// =====================
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// =====================
// SAVE REGISTRATION (PRE-PAYMENT)
// Frontend sends { type, data } where data includes a formspreeUrl field
// so /finalize-registration knows where to forward the confirmed record.
// =====================
app.post("/save-registration", async (req, res) => {
  try {
    const { type, data } = req.body;

    const result = await db.run(
      "INSERT INTO registrations (type, data) VALUES (?, ?)",
      type,
      JSON.stringify(data)
    );

    res.json({ registrationId: result.lastID });
  } catch (err) {
    console.error("Save registration failed:", err);
    res.status(500).json({ error: "Failed to save registration" });
  }
});

// =====================
// TICKETS — Individual seats or full table
// Discount codes are validated ONLY here, server-side. They are never
// sent to or computed in the browser, so they can't be read via
// dev tools / view-source. Add new codes to DISCOUNT_CODES below.
// =====================
const TICKET_PRICE = 3000;   // $30.00, in cents
const TABLE_PRICE = 20000;   // $200.00 flat, seats 8
const TABLE_SEATS = 8;

// cents off PER TICKET, individual tickets only — table deal is already a flat rate
const DISCOUNT_CODES = {
  WELCOME5: 500, // $5 off per ticket
};

app.post("/create-ticket-session", async (req, res) => {
  try {
    const { registrationId, ticketType, qty, discountCode } = req.body;

    if (!["individual", "table"].includes(ticketType)) {
      return res.status(400).json({ error: "Invalid ticket type" });
    }

    let line_items;

    if (ticketType === "table") {
      line_items = [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "YWI Luxury Picnic & Panel — Full Table (8 seats)" },
            unit_amount: TABLE_PRICE,
          },
          quantity: 1,
        },
      ];
    } else {
      const safeQty = Math.min(TABLE_SEATS, Math.max(1, parseInt(qty, 10) || 1));

      const code = (discountCode || "").trim().toUpperCase();
      const discount = DISCOUNT_CODES[code] || 0;
      const unitAmount = Math.max(0, TICKET_PRICE - discount);

      line_items = [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "YWI Luxury Picnic & Panel — Individual Ticket" },
            unit_amount: unitAmount,
          },
          quantity: safeQty,
        },
      ];
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      success_url: `${SITE_URL}/ywi-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/register.html`,
      metadata: { registrationId, type: "ywi_ticket", ticketType },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Ticket session failed:", err);
    res.status(500).json({ error: "Stripe error" });
  }
});

// =====================
// VENDORS
// =====================
const VENDOR_PRICES = {
  food_drink: { amount: 5000, name: "YWI Vendor Village — Food & Drink Vendor" },
  general:    { amount: 4000, name: "YWI Vendor Village — General Vendor" },
};

app.post("/create-vendor-session", async (req, res) => {
  try {
    const { registrationId, vendorType } = req.body;
    const chosen = VENDOR_PRICES[vendorType];

    if (!chosen) {
      return res.status(400).json({ error: "Invalid vendor type" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: chosen.name },
            unit_amount: chosen.amount,
          },
          quantity: 1,
        },
      ],
      success_url: `${SITE_URL}/ywi-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/vendors-sponsors.html`,
      metadata: { registrationId, type: "ywi_vendor", vendorType },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Vendor session failed:", err);
    res.status(500).json({ error: "Stripe error" });
  }
});

// =====================
// SPONSORS
// =====================
const SPONSOR_PRICES = {
  presenting:  { amount: 50000, name: "YWI Luxury Picnic & Panel — Presenting Sponsor" },
  main:        { amount: 30000, name: "YWI Luxury Picnic & Panel — Main Sponsor" },
  supporting:  { amount: 20000, name: "YWI Luxury Picnic & Panel — Supporting Sponsor" },
  contributing:{ amount: 10000, name: "YWI Luxury Picnic & Panel — Contributing Sponsor" },
};

app.post("/create-sponsor-session", async (req, res) => {
  try {
    const { registrationId, tier } = req.body;
    const chosen = SPONSOR_PRICES[tier];

    if (!chosen) {
      return res.status(400).json({ error: "Invalid sponsor tier" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: chosen.name },
            unit_amount: chosen.amount,
          },
          quantity: 1,
        },
      ],
      success_url: `${SITE_URL}/ywi-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/vendors-sponsors.html`,
      metadata: { registrationId, type: "ywi_sponsor", tier },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Sponsor session failed:", err);
    res.status(500).json({ error: "Stripe error" });
  }
});

// =====================
// FINALIZE REGISTRATION (POST-PAYMENT)
// Confirms payment actually went through with Stripe (never trust the
// success page alone), then forwards the saved registration data to
// the Formspree URL that was submitted with it.
// =====================
app.post("/finalize-registration", async (req, res) => {
  try {
    const { sessionId } = req.body;

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(400).json({ error: "Payment not completed" });
    }

    const registrationId = session.metadata.registrationId;

    const row = await db.get(
      "SELECT data FROM registrations WHERE id = ?",
      registrationId
    );

    if (!row) {
      return res.status(404).json({ error: "Registration not found" });
    }

    const parsedData = JSON.parse(row.data);
    const formspreeUrl = parsedData.formspreeUrl;

    if (formspreeUrl) {
      await fetch(formspreeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: row.data,
      });
    }

    res.json({
      status: "ok",
      type: session.metadata.type,
      registrationId,
      ticketType: session.metadata.ticketType || "",
      vendorType: session.metadata.vendorType || "",
      tier: session.metadata.tier || "",
    });
  } catch (err) {
    console.error("Finalize failed:", err);
    res.status(500).json({ error: "Finalize failed" });
  }
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`YWI backend running on port ${PORT}`);
});
