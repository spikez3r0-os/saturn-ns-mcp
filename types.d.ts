// Augment the generated Env interface with our secrets.
// (DO bindings are typed from wrangler.jsonc into worker-configuration.d.ts.)
interface Env {
  // Bearer token gating /admin and the MCP transport endpoints.
  ADMIN_TOKEN: string

  // Default NetSuite environment when a company record omits it ("production" | "sandbox").
  NS_DEFAULT_ENVIRONMENT?: string
}

/** Props that the MCP transport middleware attaches to the McpAgent context. */
type NSAuthContext = {
  slug: string
  adminToken: string
}

/** Onboarding record persisted in the per-company Durable Object. */
interface CompanyRecord {
  slug: string
  display_name: string
  account_id: string            // NetSuite account id, e.g. "5637369" or "TSTDRV1234567"
  environment: "production" | "sandbox"
  is_oneworld: boolean
  primary_subsidiary_id?: string
  default_currency?: string
  auth_mode: "oauth_m2m" | "tba"

  // OAuth 2.0 M2M (JWT Bearer, PS256) — primary
  oauth?: {
    consumer_key: string        // a.k.a. client_id, from the NS integration record
    certificate_id?: string     // returned by NS when the public key is uploaded
    public_key_pem: string      // shown in admin; uploaded to NS by Saturn
    private_key_jwk: JsonWebKey // unextractable private half stored here
    scope?: string              // defaults to "rest_webservices"
  }

  // Token-Based Authentication (OAuth 1.0a) — fallback only
  tba?: {
    consumer_key: string
    consumer_secret: string
    token_id: string
    token_secret: string
  }

  created_at: number
  updated_at: number
}

/** Cached OAuth access token entry (stored alongside the company record). */
interface CachedAccessToken {
  access_token: string
  token_type: string
  expires_at: number            // epoch ms
  scope?: string
}
