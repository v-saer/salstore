# SalStore

SalStore is a Telegram Premium order storefront with public-profile lookup and three fixed ABA Pay links.

## Run locally

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env`. The three plan-specific ABA Pay URLs are already configured; replace them if ABA issues new links.
4. Start the app with `npm run dev`, then open `http://localhost:4242`.
5. Create a Telegram bot with BotFather, add it to a private order chat or group, and set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ORDER_CHAT_ID` in `.env`.

The profile endpoint is proxied server-side to `https://thlockup.vercel.app/api/v1/telegram/profile`. The server maps the selected plan to its configured ABA link. No card or bank credentials pass through SalStore.

## Important fulfillment boundary

The supplied Telegram endpoint only reads profile details; it has no operation that buys or activates Telegram Premium. These fixed ABA Pay links do not provide SalStore with a verifiable transaction callback. After payment, a customer can tap **I've paid** to send a Telegram bot alert labeled **payment claimed — verify in ABA**. This alert is not proof of payment. Confirm payments through your ABA merchant records before fulfillment.

Because ABA links are fixed, the website can select the correct plan but cannot embed the buyer's Telegram username in ABA's payment record. Telegram Premium is not activated automatically.
