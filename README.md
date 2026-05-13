# saturn-ns-mcp

Multi-tenant, OneWorld-aware **NetSuite MCP server** running on Cloudflare
Workers. Mirrors the structure of
[`saturn-qb-mcp`](https://github.com/spikez3r0-os/saturn-qb-mcp), substituting
QuickBooks for NetSuite SuiteTalk REST + SuiteQL.

Primary auth: **OAuth 2.0 Client Credentials with JWT Bearer (PS256)** — a
per-client RSA-2048 keypair is generated at onboarding and the private half is
stored in the per-company Durable Object. Saturn uploads the public half to
NetSuite's certificate manager and pastes the returned certificate id back
into the admin console.

Fallback auth: **Token-Based Authentication (OAuth 1.0a, HMAC-SHA256)** for
accounts that don't support OAuth 2.0 M2M.

> **v1 ships empty.** No NetSuite credentials are in hand at deploy time. The
> admin console shows an empty registered-companies list until Saturn
> completes Little Words Project (account_id `5637369`) onboarding manually
> after deployment.

## File tree

```
.
├── api/
│   ├── NetSuiteAccountStore.ts   # Durable Object — per-company record, keypair, token cache
│   ├── NetSuiteMCP.ts            # McpAgent — the 11 v1 tools
│   ├── NetSuiteService.ts        # SuiteTalk REST + SuiteQL client
│   ├── index.ts                  # Hono app — admin console, onboarding API, MCP routing
│   └── lib/
│       └── auth.ts               # Bearer middleware, RSA keypair gen, JWT PS256 + TBA signer
├── .dev.vars.template
├── .gitignore
├── .github/CODEOWNERS
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE                        # Apache-2.0
├── README.md
├── package.json
├── tsconfig.json
├── tsconfig.worker.json
├── types.d.ts
└── wrangler.jsonc
```

## v1 MCP tools

All tools take a `slug` (company identifier) as their first parameter, except
`list_companies` (slug optional, ignored).

| Tool                          | Description                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `list_companies`              | Registered companies (redacted). Empty until LWP is onboarded.               |
| `list_subsidiaries`           | OneWorld subsidiaries via SuiteQL.                                           |
| `list_bank_accounts`          | Bank-type GL accounts (`accttype = 'Bank'`).                                 |
| `get_unmatched_summary`       | Per-bank-account counts/totals of unmatched bank statement lines.            |
| `search_bank_lines`           | Filterable bank-feed line search.                                            |
| `search_account_transactions` | Filterable GL transactions hitting a bank account.                           |
| `find_match_candidates`       | Ranked candidates for a single bank line (default `obvious_only=true` ≥0.95).|
| `create_bank_match`           | **Strictly one-to-one** bank-line → GL-transaction match. Arrays rejected.   |
| `exclude_bank_line`           | Mark a bank line as excluded (with optional reason).                         |
| `unmatch`                     | Delete the match record for a bank line.                                     |

Out of scope for v1: bulk write tools, automated key rotation, clients beyond
LWP, native NetSuite AI Connector.

## Environment

Worker URL target: `https://saturn-ns-mcp.jonathan-9321-jr.workers.dev`

Secrets:

| Name                     | Purpose                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `ADMIN_TOKEN`            | Bearer token gating `/admin/api/*` and `/mcp/:slug`, `/sse/:slug`. Long random.      |

Vars (non-secret; can also live in wrangler.jsonc):

| Name                     | Default        | Purpose                                                |
| ------------------------ | -------------- | ------------------------------------------------------ |
| `NS_DEFAULT_ENVIRONMENT` | `production`   | Default for a new company when `environment` is omitted |

Durable Object bindings (declared in `wrangler.jsonc`):

| Binding           | Class                  |
| ----------------- | ---------------------- |
| `NS_MCP_OBJECT`   | `NetSuiteMCP`          |
| `NS_ACCOUNT_STORE`| `NetSuiteAccountStore` |

## HTTP surface

| Method | Path                                       | Auth          | Purpose                                     |
| ------ | ------------------------------------------ | ------------- | ------------------------------------------- |
| GET    | `/`                                        | none          | Admin console (HTML/JS)                     |
| GET    | `/health`                                  | none          | JSON health check                           |
| GET    | `/terms`, `/privacy`                       | none          | Policy pages                                |
| GET    | `/admin/api/companies`                     | bearer        | List redacted company records               |
| POST   | `/admin/api/companies/:slug/keypair`       | bearer        | Generate RSA-2048 keypair, return public PEM |
| POST   | `/admin/api/companies/:slug`               | bearer        | Onboard / replace a company record          |
| PATCH  | `/admin/api/companies/:slug`               | bearer        | Update `certificate_id` and other safe fields |
| DELETE | `/admin/api/companies/:slug`               | bearer        | Remove a company                            |
| ANY    | `/mcp/:slug`, `/mcp/:slug/*`               | bearer        | MCP HTTP transport                          |
| GET    | `/sse/:slug`, `/sse/:slug/*`               | bearer        | MCP SSE transport                           |

## Deployment

```bash
# 1. Install
npm install

# 2. Set the admin bearer secret
wrangler secret put ADMIN_TOKEN
# (paste a long random string when prompted)

# 3. (Optional) Set the default NetSuite environment
echo 'NS_DEFAULT_ENVIRONMENT = "production"' | wrangler vars put NS_DEFAULT_ENVIRONMENT  # or edit wrangler.jsonc

# 4. Deploy
wrangler deploy
# → publishes to saturn-ns-mcp.jonathan-9321-jr.workers.dev
```

Local development:

```bash
cp .dev.vars.template .dev.vars   # then edit ADMIN_TOKEN
npm run dev                       # http://localhost:3000
```

## Onboarding flow (post-deploy)

For Little Words Project (`account_id = 5637369`), once Saturn has the
NetSuite integration record's Client ID in hand:

1. Open `https://saturn-ns-mcp.jonathan-9321-jr.workers.dev/`, paste
   `ADMIN_TOKEN`.
2. Enter slug (`little-words-project`), display name, account id `5637369`,
   environment (`production` or `sandbox`), auth mode `oauth_m2m`.
3. Click **Generate keypair** — copy the PEM into NetSuite at
   *Setup → Integration → OAuth 2.0 Client Credentials Setup* and upload it as
   a certificate. NetSuite returns a Certificate ID.
4. Paste the Consumer Key (Client ID) and Certificate ID into the form, then
   **Onboard company**. The private key half is stored in the per-company
   Durable Object and never returned.

If LWP's account doesn't have OAuth 2.0 M2M enabled, choose `tba` instead and
paste the four OAuth 1.0a secrets — the worker will sign each call inline
with HMAC-SHA256.

## Validation output

The repository ships with no NetSuite credentials, so the validation we can
run against the build is structural:

* `npm install` resolves and `wrangler types && tsc -b` should typecheck (run
  this locally after install; the build environment here has no internet).
* `wrangler dev` boots on `:3000` and `GET /` returns the admin login page.
* `GET /health` returns `{ "ok": true, "service": "saturn-ns-mcp", "version": "0.1.0" }`.
* `GET /admin/api/companies` with the bearer token returns `{"companies":[]}`.
* `POST /admin/api/companies/test/keypair` with the bearer token returns a
  PEM-encoded RSA-2048 public key.

Full end-to-end validation against NetSuite happens after Saturn completes
LWP onboarding.
