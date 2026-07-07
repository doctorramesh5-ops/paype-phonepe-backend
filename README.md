# PayPe × PhonePe TSP — UAT Test Project

A complete test setup for PhonePe Standard Checkout (TSP model) in the UAT sandbox.
Built by Ramesh + Claude, PayPe Technologies, Coimbatore.

## What's inside

| File | What it does |
|---|---|
| `server.js` | Backend: auth token, create payment, order status, webhook receiver |
| `public/index.html` | Test checkout page with Pay button |
| `public/result.html` | Page the customer returns to; shows Success / Failed / Pending |
| `.env` | Your PhonePe UAT credentials (keep secret, never upload to GitHub) |

## How to run (first time)

1. **Install Node.js** (if not installed): download the LTS version from https://nodejs.org

2. **Open a terminal** in this folder and install the dependencies:
   ```
   npm install
   ```

3. **Start the server:**
   ```
   npm start
   ```
   You should see: `🚀 PayPe UAT server running → http://localhost:3000`

4. **Open** http://localhost:3000 in your browser, enter an amount, and click **Pay with PhonePe**.
   You'll be redirected to PhonePe's sandbox checkout page.

## Important: set the mock template first

PhonePe's email said: in UAT you must **set the response template** against the test MID (`TSPPAYPE`) to get mock Success / Failure / Pending responses.
Do this in the UAT Sandbox portal (link from their email) before testing, otherwise payments may not simulate correctly.
Test all three: Success ✅, Failure ❌, Pending ⏳.

## Webhooks (step after basic flow works)

PhonePe sends payment updates to `POST /api/phonepe-webhook`.
Since `localhost` is not reachable from the internet, you need a public URL:
- Quick option for testing: `npx ngrok http 3000` (gives a temporary public URL)
- Permanent option: deploy this project to Render / Railway (free tiers available)

Then register that URL using PhonePe's **Create Webhook API** (link in their email).

## Moving to production later

1. Base URL changes:
   - Auth: `https://api.phonepe.com/apis/identity-manager`
   - Other APIs: `https://api.phonepe.com/apis/pg`
2. Replace UAT credentials in `.env` with production credentials from PhonePe.
3. `X-MERCHANT-ID` must be each **real end merchant's MID** (your onboarded client), not TSPPAYPE.
4. Change `redirectUrl` in server.js from localhost to your real domain.

## Golden rules

- The `clientSecret` lives only in `.env` on the server. Never in browser code, never in WhatsApp, never in GitHub.
- Always confirm payment success from the **Order Status API or webhook** — never trust only the browser redirect.
