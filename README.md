# GaláxiaLunarium

<p>
  <a href="https://galaxia.lunariumcoin.com/?coin=xln"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fgalaxia.lunariumcoin.com%2Fapi%2Fv1%2Fcoins%2Fxln&query=%24.data.market_cap_usd&prefix=%24&label=XLN%20market%20cap&color=1f6feb&cacheSeconds=1800" alt="XLN market cap (live)"/></a>
  <a href="https://galaxia.lunariumcoin.com/?coin=xln"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fgalaxia.lunariumcoin.com%2Fapi%2Fv1%2Fcoins%2Fxln&query=%24.data.price_usd&prefix=%24&label=XLN%20price&color=1f6feb&cacheSeconds=1800" alt="XLN price (live)"/></a>
</p>

The Lunarium market aggregator, live at [galaxia.lunariumcoin.com](https://galaxia.lunariumcoin.com): prices, markets and market caps for LunariumCoin (XLN), XLNFT and other masternode, mining, stake and token projects, with public on-chain audits of their issuance.

## What it does

- **Prices and markets** read server-side from each exchange's official API (partner and major exchanges), so the browser never depends on CORS. XLN's headline price is the highest live price among its exchanges.
- **Market cap only from verifiable data**: supply comes from each coin's own chain or explorer (`coin-supply.js`, `coin-supply-sources.json`); when it cannot be verified, the site shows "—" instead of a number.
- **Issuance audits** (`major-audits.js`, `token-audit-xlnft.js`, XLN audit in `server.js`): block rewards and supply checked against each project's official source code rules (PIVX-style masternode coins, Bitcoin, Litecoin, Dogecoin, Bitcoin Cash, Dash, Ethereum PoS, BNB burns, XLNFT transfers).
- **Masternode collateral** rules read from each coin's official code (`masternode-collateral.js`).
- **Exchange volume check** flags exchanges whose volume looks bot-driven (`exchange-volume-check.js`).
- **Health monitor** e-mails the team when an audit source, an audit or a certificate breaks (`health-monitor.js`).
- **Public API v1** (`public-api.js`): read-only JSON, CORS open, rate limited per IP (free) or per API key (paid plans, priced in USD and paid in XLN).
- **Checkout paid in XLN** (`api-orders.js`): each order gets a unique 4-decimal amount, and the payment is matched on chain through the [Lunarium explorer](https://github.com/Lunariumcoin-Labs/lunarium-explorer); no manual step for API plans.
- **Accounts, price alerts and listing requests** (`api-accounts.js`, `price-alerts.js`, `listings.js`), with e-mails in the visitor's language.
- **Website** (`public/`): a multilingual single-page site with light and dark themes; prices follow the currency of the chosen language.

## Security

All state and secrets live only on the server, in `data/`, which is never committed: accounts, sessions, API keys, orders, `secret.key` and the mail settings. Passwords are hashed with scrypt; sessions, API keys and order tokens are stored hashed. The admin panel answers at a random address kept in `data/admin.json`, and every other path returns 404. `security.js` adds the security headers and limits `/api` query values to short plain text.

## Running

```
npm install --omit=dev
node server.js
```

Node.js 18 or later. The server listens on `PORT` (default 3001) and creates `data/` on first use. The e-mail settings (`data/mail.json`) are optional; without them, alerts are not sent. `tools/` holds the server-side admin scripts (API keys, orders, admin panel setup).

## License

[MIT](LICENSE) © 2026 Lunariumcoin Labs. Third-party logos and icons in `public/` are trademarks of their respective owners and are not covered by the license.
