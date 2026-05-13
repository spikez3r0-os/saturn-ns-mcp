/* eslint-disable @typescript-eslint/no-explicit-any */
import { Hono } from "hono"
import { cors } from "hono/cors"
import { HTTPException } from "hono/http-exception"
import { NetSuiteMCP } from "./NetSuiteMCP"
import { NetSuiteAccountStore } from "./NetSuiteAccountStore"
import { adminBearerMiddleware, mcpTransportMiddleware } from "./lib/auth"

// Export Durable Object classes so the Worker runtime can find them.
export { NetSuiteMCP, NetSuiteAccountStore }

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/

function slugOk(slug: string): boolean {
  return SLUG_RE.test(slug) && slug !== "__roster__"
}

function accountStore(env: Env, slug: string) {
  return env.NS_ACCOUNT_STORE.get(env.NS_ACCOUNT_STORE.idFromName(slug))
}

function roster(env: Env) {
  return env.NS_ACCOUNT_STORE.get(env.NS_ACCOUNT_STORE.idFromName("__roster__"))
}

const app = new Hono<{ Bindings: Env }>()
  .use(cors())

  // -------------------------------------------------------------------------
  // Public root — admin console landing page (login form).
  // -------------------------------------------------------------------------
  .get("/", (c) => c.html(adminPage()))

  // -------------------------------------------------------------------------
  // Admin API (all guarded by ADMIN_TOKEN bearer auth).
  // -------------------------------------------------------------------------
  .use("/admin/api/*", adminBearerMiddleware)

  // GET /admin/api/companies — list registered companies (redacted).
  .get("/admin/api/companies", async (c) => {
    const slugs = await roster(c.env).listSlugs()
    const records: Array<Record<string, unknown> | null> = []
    for (const s of slugs) {
      records.push(await accountStore(c.env, s).redactedRecord())
    }
    return c.json({ companies: records.filter(Boolean) })
  })

  // POST /admin/api/companies/:slug/keypair — generate a fresh RSA-2048 keypair
  // and return the public key PEM for upload to NetSuite. The private half is
  // stashed in the per-company DO until the onboarding form is submitted.
  .post("/admin/api/companies/:slug/keypair", async (c) => {
    const slug = c.req.param("slug")
    if (!slugOk(slug)) throw new HTTPException(400, { message: "invalid slug" })
    const { public_pem, generated_at } = await accountStore(c.env, slug).generateKeypair()
    return c.json({ slug, public_pem, generated_at })
  })

  // POST /admin/api/companies/:slug — onboard a new company. The pending
  // keypair (if any) is consumed and stored alongside the rest of the record.
  // Body schema:
  //   {
  //     display_name, account_id, environment, is_oneworld,
  //     primary_subsidiary_id?, default_currency?,
  //     auth_mode: "oauth_m2m" | "tba",
  //     oauth?:  { consumer_key, certificate_id?, scope? },
  //     tba?:    { consumer_key, consumer_secret, token_id, token_secret }
  //   }
  .post("/admin/api/companies/:slug", async (c) => {
    const slug = c.req.param("slug")
    if (!slugOk(slug)) throw new HTTPException(400, { message: "invalid slug" })
    const body = await c.req.json<{
      display_name: string
      account_id: string
      environment?: "production" | "sandbox"
      is_oneworld?: boolean
      primary_subsidiary_id?: string
      default_currency?: string
      auth_mode: "oauth_m2m" | "tba"
      oauth?: { consumer_key: string; certificate_id?: string; scope?: string }
      tba?: {
        consumer_key: string
        consumer_secret: string
        token_id: string
        token_secret: string
      }
    }>()

    if (!body.display_name || !body.account_id) {
      throw new HTTPException(400, { message: "display_name and account_id are required" })
    }
    if (body.auth_mode !== "oauth_m2m" && body.auth_mode !== "tba") {
      throw new HTTPException(400, { message: "auth_mode must be 'oauth_m2m' or 'tba'" })
    }

    const store = accountStore(c.env, slug)
    const now = Date.now()
    const environment = body.environment ?? (c.env.NS_DEFAULT_ENVIRONMENT as any) ?? "production"

    let oauth: CompanyRecord["oauth"]
    if (body.auth_mode === "oauth_m2m") {
      if (!body.oauth?.consumer_key) {
        throw new HTTPException(400, { message: "oauth.consumer_key is required for oauth_m2m" })
      }
      const pending = await store.consumePendingKeypair()
      if (!pending) {
        throw new HTTPException(400, {
          message:
            "No pending keypair for this slug — click 'Generate keypair' before submitting the form",
        })
      }
      oauth = {
        consumer_key: body.oauth.consumer_key,
        certificate_id: body.oauth.certificate_id,
        public_key_pem: pending.publicPem,
        private_key_jwk: pending.privateJwk,
        scope: body.oauth.scope ?? "rest_webservices",
      }
    }

    let tba: CompanyRecord["tba"]
    if (body.auth_mode === "tba") {
      if (
        !body.tba?.consumer_key ||
        !body.tba?.consumer_secret ||
        !body.tba?.token_id ||
        !body.tba?.token_secret
      ) {
        throw new HTTPException(400, {
          message: "tba.{consumer_key, consumer_secret, token_id, token_secret} are all required",
        })
      }
      tba = { ...body.tba }
    }

    const record: CompanyRecord = {
      slug,
      display_name: body.display_name,
      account_id: body.account_id,
      environment,
      is_oneworld: body.is_oneworld ?? false,
      primary_subsidiary_id: body.primary_subsidiary_id,
      default_currency: body.default_currency,
      auth_mode: body.auth_mode,
      oauth,
      tba,
      created_at: now,
      updated_at: now,
    }
    await store.putRecord(record)
    await roster(c.env).addSlug(slug)
    return c.json({ ok: true, company: await store.redactedRecord() }, 201)
  })

  // DELETE /admin/api/companies/:slug — remove a company.
  .delete("/admin/api/companies/:slug", async (c) => {
    const slug = c.req.param("slug")
    if (!slugOk(slug)) throw new HTTPException(400, { message: "invalid slug" })
    await accountStore(c.env, slug).deleteRecord()
    await roster(c.env).removeSlug(slug)
    return c.json({ ok: true })
  })

  // PATCH /admin/api/companies/:slug — update the certificate_id (after Saturn
  // uploads the public key in NetSuite) or other safe fields.
  .patch("/admin/api/companies/:slug", async (c) => {
    const slug = c.req.param("slug")
    if (!slugOk(slug)) throw new HTTPException(400, { message: "invalid slug" })
    const body = await c.req.json<{
      certificate_id?: string
      primary_subsidiary_id?: string
      default_currency?: string
      environment?: "production" | "sandbox"
    }>()
    const store = accountStore(c.env, slug)
    const current = await store.getRecord()
    if (!current) throw new HTTPException(404, { message: "company not found" })
    if (body.certificate_id && current.oauth) {
      current.oauth.certificate_id = body.certificate_id
    }
    if (body.primary_subsidiary_id !== undefined)
      current.primary_subsidiary_id = body.primary_subsidiary_id
    if (body.default_currency !== undefined) current.default_currency = body.default_currency
    if (body.environment) current.environment = body.environment
    current.updated_at = Date.now()
    await store.putRecord(current)
    return c.json({ ok: true, company: await store.redactedRecord() })
  })

  // -------------------------------------------------------------------------
  // MCP transport endpoints — bearer-gated, slug from path.
  // -------------------------------------------------------------------------
  .use("/sse/:slug/*", mcpTransportMiddleware)
  .use("/sse/:slug", mcpTransportMiddleware)
  .route(
    "/sse/:slug",
    new Hono().mount(
      "/",
      NetSuiteMCP.serveSSE("/sse/:slug", { binding: "NS_MCP_OBJECT" }).fetch
    )
  )

  .use("/mcp/:slug", mcpTransportMiddleware)
  .route(
    "/mcp/:slug",
    new Hono().mount(
      "/",
      NetSuiteMCP.serve("/mcp/:slug", { binding: "NS_MCP_OBJECT" }).fetch
    )
  )

  // -------------------------------------------------------------------------
  // Health, terms, privacy.
  // -------------------------------------------------------------------------
  .get("/health", (c) => c.json({ ok: true, service: "saturn-ns-mcp", version: "0.1.0" }))

  .get("/terms", (c) =>
    c.html(
      `<!DOCTYPE html><html><head><title>Terms of Service</title></head><body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 20px"><h1>Terms of Service</h1><p>Saturn NetSuite MCP server is provided as-is for integrating NetSuite data with MCP-compatible clients on behalf of authorized users.</p><p>By using this service, you agree to comply with Oracle NetSuite's API terms and to use the service responsibly.</p></body></html>`
    )
  )

  .get("/privacy", (c) =>
    c.html(
      `<!DOCTYPE html><html><head><title>Privacy Policy</title></head><body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 20px"><h1>Privacy Policy</h1><p>Saturn NetSuite MCP server processes NetSuite data on behalf of authenticated users via OAuth 2.0 client-credentials with JWT bearer authentication (PS256). Per-tenant credentials and signing keys are stored in encrypted Durable Object storage and are never returned over the API.</p><p>OAuth access tokens are cached transiently and refreshed on expiry. No NetSuite business data is persisted by this service.</p></body></html>`
    )
  )

export default app

// ===========================================================================
// Admin console (HTML+JS, served at /).
// ===========================================================================

function adminPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Saturn NetSuite MCP — Admin</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 880px; margin: 40px auto; padding: 0 20px; color: #1c2024; }
    h1 { margin-top: 0; }
    h2 { margin-top: 32px; border-bottom: 1px solid #e6e8eb; padding-bottom: 4px; }
    label { display: block; margin: 12px 0 4px; font-size: 13px; color: #5e6a78; }
    input, select, textarea { width: 100%; padding: 8px 10px; border: 1px solid #cbd0d6; border-radius: 6px; font-size: 14px; font-family: inherit; }
    textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; min-height: 140px; }
    button { padding: 8px 14px; border: 0; border-radius: 6px; background: #0e6efd; color: #fff; font-weight: 500; cursor: pointer; margin-top: 12px; }
    button.secondary { background: #5e6a78; }
    button.danger { background: #d63a3a; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .row { display: flex; gap: 12px; }
    .row > div { flex: 1; }
    .card { border: 1px solid #e6e8eb; border-radius: 8px; padding: 16px; margin: 12px 0; }
    .muted { color: #5e6a78; font-size: 13px; }
    .hidden { display: none; }
    .empty { padding: 24px; text-align: center; color: #5e6a78; background: #f7f8f9; border-radius: 8px; }
    pre { background: #f7f8f9; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
    .status { padding: 8px 12px; border-radius: 6px; margin: 12px 0; font-size: 14px; }
    .status.ok { background: #e6f4ea; color: #137333; }
    .status.err { background: #fce8e6; color: #c5221f; }
  </style>
</head>
<body>
  <h1>Saturn NetSuite MCP — Admin</h1>
  <p class="muted">Multi-tenant Cloudflare Worker exposing the NetSuite MCP toolset. v1: onboarding only — no NetSuite credentials are pre-loaded.</p>

  <div id="login-section">
    <label for="token">Admin token (ADMIN_TOKEN secret)</label>
    <input id="token" type="password" placeholder="Paste the ADMIN_TOKEN secret" autocomplete="off" />
    <button onclick="login()">Sign in</button>
    <div id="login-status"></div>
  </div>

  <div id="app" class="hidden">
    <h2>Registered companies</h2>
    <div id="companies"></div>

    <h2>Onboard a new company</h2>
    <div class="card">
      <label for="slug">Slug (lowercase, hyphens; unique)</label>
      <input id="slug" placeholder="e.g. little-words-project" />

      <div class="row">
        <div>
          <label for="display_name">Display name</label>
          <input id="display_name" placeholder="Little Words Project" />
        </div>
        <div>
          <label for="account_id">NetSuite account id</label>
          <input id="account_id" placeholder="5637369" />
        </div>
      </div>

      <div class="row">
        <div>
          <label for="environment">Environment</label>
          <select id="environment">
            <option value="production">production</option>
            <option value="sandbox">sandbox</option>
          </select>
        </div>
        <div>
          <label for="auth_mode">Auth mode</label>
          <select id="auth_mode" onchange="renderAuthFields()">
            <option value="oauth_m2m">OAuth 2.0 M2M (JWT Bearer, PS256) — primary</option>
            <option value="tba">Token-Based Auth (OAuth 1.0a) — fallback</option>
          </select>
        </div>
      </div>

      <div class="row">
        <div>
          <label for="is_oneworld">OneWorld?</label>
          <select id="is_oneworld">
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
        </div>
        <div>
          <label for="primary_subsidiary_id">Primary subsidiary id (optional)</label>
          <input id="primary_subsidiary_id" placeholder="e.g. 2" />
        </div>
      </div>

      <div id="oauth-fields">
        <h3>OAuth 2.0 M2M credentials</h3>
        <label for="oauth_consumer_key">Consumer key (Client ID from the NS integration record)</label>
        <input id="oauth_consumer_key" placeholder="e.g. 8f3c…" />

        <label>Public key for upload to NetSuite</label>
        <p class="muted">Click <em>Generate keypair</em>, copy the PEM into NetSuite (Setup → Integration → OAuth 2.0 Client Credentials → upload certificate), then paste the Certificate ID NetSuite returns into the field below before submitting.</p>
        <button class="secondary" onclick="generateKeypair()">Generate keypair</button>
        <textarea id="public_pem" readonly placeholder="(no keypair generated yet)"></textarea>

        <label for="oauth_certificate_id">Certificate ID (paste from NetSuite after upload)</label>
        <input id="oauth_certificate_id" placeholder="(leave blank to set later via PATCH)" />
      </div>

      <div id="tba-fields" class="hidden">
        <h3>TBA credentials</h3>
        <div class="row">
          <div>
            <label for="tba_consumer_key">Consumer key</label>
            <input id="tba_consumer_key" />
          </div>
          <div>
            <label for="tba_consumer_secret">Consumer secret</label>
            <input id="tba_consumer_secret" type="password" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="tba_token_id">Token ID</label>
            <input id="tba_token_id" />
          </div>
          <div>
            <label for="tba_token_secret">Token secret</label>
            <input id="tba_token_secret" type="password" />
          </div>
        </div>
      </div>

      <button onclick="submitCompany()">Onboard company</button>
      <div id="onboard-status"></div>
    </div>
  </div>

  <script>
    let token = "";

    function $(id) { return document.getElementById(id); }
    function show(id) { $(id).classList.remove("hidden"); }
    function hide(id) { $(id).classList.add("hidden"); }
    function setStatus(id, text, ok) {
      const el = $(id);
      el.className = "status " + (ok ? "ok" : "err");
      el.textContent = text;
    }

    async function api(method, path, body) {
      const res = await fetch(path, {
        method,
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
      if (!res.ok) throw new Error(data?.message || data?.error || "HTTP " + res.status);
      return data;
    }

    async function login() {
      token = $("token").value.trim();
      if (!token) return;
      try {
        await api("GET", "/admin/api/companies");
        hide("login-section");
        show("app");
        renderAuthFields();
        loadCompanies();
      } catch (e) {
        setStatus("login-status", e.message, false);
      }
    }

    function renderAuthFields() {
      const mode = $("auth_mode").value;
      if (mode === "oauth_m2m") { show("oauth-fields"); hide("tba-fields"); }
      else { hide("oauth-fields"); show("tba-fields"); }
    }

    async function loadCompanies() {
      try {
        const { companies } = await api("GET", "/admin/api/companies");
        const el = $("companies");
        if (!companies || companies.length === 0) {
          el.innerHTML = '<div class="empty">No companies registered yet. v1 ships empty by design — Little Words Project (account_id 5637369) will be onboarded manually after deployment.</div>';
          return;
        }
        el.innerHTML = companies.map(c => \`
          <div class="card">
            <strong>\${c.display_name}</strong> <span class="muted">(slug: \${c.slug})</span>
            <div class="muted">account_id \${c.account_id} · \${c.environment} · \${c.auth_mode}\${c.is_oneworld ? ' · OneWorld' : ''}</div>
            <button class="danger" onclick="removeCompany('\${c.slug}')">Remove</button>
          </div>\`).join("");
      } catch (e) {
        $("companies").innerHTML = '<div class="status err">' + e.message + '</div>';
      }
    }

    async function removeCompany(slug) {
      if (!confirm("Remove " + slug + "?")) return;
      try { await api("DELETE", "/admin/api/companies/" + slug); loadCompanies(); }
      catch (e) { alert(e.message); }
    }

    async function generateKeypair() {
      const slug = $("slug").value.trim();
      if (!slug) { alert("Enter a slug first"); return; }
      try {
        const res = await api("POST", "/admin/api/companies/" + slug + "/keypair");
        $("public_pem").value = res.public_pem;
      } catch (e) { alert(e.message); }
    }

    async function submitCompany() {
      const slug = $("slug").value.trim();
      const body = {
        display_name: $("display_name").value.trim(),
        account_id: $("account_id").value.trim(),
        environment: $("environment").value,
        is_oneworld: $("is_oneworld").value === "true",
        primary_subsidiary_id: $("primary_subsidiary_id").value.trim() || undefined,
        auth_mode: $("auth_mode").value,
      };
      if (body.auth_mode === "oauth_m2m") {
        body.oauth = {
          consumer_key: $("oauth_consumer_key").value.trim(),
          certificate_id: $("oauth_certificate_id").value.trim() || undefined,
        };
      } else {
        body.tba = {
          consumer_key: $("tba_consumer_key").value.trim(),
          consumer_secret: $("tba_consumer_secret").value,
          token_id: $("tba_token_id").value.trim(),
          token_secret: $("tba_token_secret").value,
        };
      }
      try {
        await api("POST", "/admin/api/companies/" + slug, body);
        setStatus("onboard-status", "Onboarded " + slug, true);
        loadCompanies();
      } catch (e) {
        setStatus("onboard-status", e.message, false);
      }
    }
  </script>
</body>
</html>`
}
