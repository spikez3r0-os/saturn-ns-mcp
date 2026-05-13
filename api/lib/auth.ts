/* eslint-disable @typescript-eslint/no-explicit-any */
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"

/**
 * Bearer-token middleware for both the admin console (/admin/api/*) and the
 * MCP transport endpoints (/mcp/:slug, /sse/:slug). The token is compared
 * against the ADMIN_TOKEN secret in constant time.
 *
 * For MCP transport endpoints, the :slug path param is also extracted and
 * attached to executionCtx.props so the McpAgent can locate the per-company
 * Durable Object on init.
 */
export const adminBearerMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const authHeader = c.req.header("Authorization") || ""
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
    if (!token || !c.env.ADMIN_TOKEN || !timingSafeEqual(token, c.env.ADMIN_TOKEN)) {
      throw new HTTPException(401, { message: "Invalid or missing admin token" })
    }
    await next()
  }
)

export const mcpTransportMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const authHeader = c.req.header("Authorization") || ""
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
    if (!token || !c.env.ADMIN_TOKEN || !timingSafeEqual(token, c.env.ADMIN_TOKEN)) {
      throw new HTTPException(401, { message: "Invalid or missing admin token" })
    }
    const slug = c.req.param("slug") || ""
    if (!slug) {
      throw new HTTPException(400, { message: "Company slug missing from path" })
    }
    // @ts-ignore Props injected for McpAgent
    c.executionCtx.props = { slug, adminToken: token } satisfies NSAuthContext
    await next()
  }
)

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

// ===========================================================================
// RSA-2048 keypair generation for OAuth 2.0 M2M (JWT Bearer, PS256)
// ===========================================================================

/**
 * Generate a fresh RSA-2048 keypair for client-assertion signing.
 * Returns the private key as a JWK that can be re-imported later (extractable
 * so we can persist it in DO storage) and the public key as a PEM string
 * suitable for upload to NetSuite's certificate management UI.
 */
export async function generateRsaKeypair(): Promise<{
  privateJwk: JsonWebKey
  publicPem: string
  publicJwk: JsonWebKey
}> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSA-PSS",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair

  const privateJwk = (await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as JsonWebKey
  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey
  const spki = (await crypto.subtle.exportKey("spki", keyPair.publicKey)) as ArrayBuffer
  const publicPem = spkiToPem(new Uint8Array(spki))

  return { privateJwk, publicPem, publicJwk }
}

function spkiToPem(spki: Uint8Array): string {
  const b64 = base64FromBytes(spki)
  const wrapped = b64.match(/.{1,64}/g)?.join("\n") ?? b64
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`
}

// ===========================================================================
// JWT client assertion (NetSuite OAuth 2.0 M2M, PS256)
// ===========================================================================

/**
 * Build and sign a JWT client assertion for NetSuite's OAuth 2.0
 * client-credentials flow with JWT Bearer authentication.
 *
 * https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_162686838198.html
 *
 * iss = sub = consumer_key (the integration record's Client ID)
 * aud = the NS token endpoint
 * iat = now, exp = now + 300s (NS allows up to 1 hour)
 * Header kid = the certificate_id returned when the public key was uploaded
 */
export async function signNetSuiteClientAssertion(opts: {
  consumerKey: string
  certificateId: string
  privateJwk: JsonWebKey
  tokenUrl: string
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { typ: "JWT", alg: "PS256", kid: opts.certificateId }
  const payload = {
    iss: opts.consumerKey,
    sub: opts.consumerKey,
    aud: opts.tokenUrl,
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID(),
  }
  const encodedHeader = base64UrlFromString(JSON.stringify(header))
  const encodedPayload = base64UrlFromString(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`

  const key = await crypto.subtle.importKey(
    "jwk",
    opts.privateJwk,
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    key,
    new TextEncoder().encode(signingInput)
  )
  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(sig))}`
}

/**
 * Exchange a client assertion for an OAuth 2.0 access token at the NetSuite
 * token endpoint. Returns the parsed token response.
 */
export async function exchangeJwtForAccessToken(opts: {
  tokenUrl: string
  clientAssertion: string
  scope?: string
}): Promise<{
  access_token: string
  token_type: string
  expires_in: number
  scope?: string
}> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: opts.clientAssertion,
  })
  if (opts.scope) body.set("scope", opts.scope)

  const res = await fetch(opts.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`NetSuite OAuth token exchange failed (${res.status}): ${text}`)
  }
  return res.json()
}

// ===========================================================================
// TBA (OAuth 1.0a, HMAC-SHA256) signer — fallback for legacy accounts
// ===========================================================================

/**
 * Build an OAuth 1.0a Authorization header for a NetSuite TBA request.
 * Uses HMAC-SHA256 (the variant NetSuite requires; HMAC-SHA1 is rejected).
 */
export async function buildTbaAuthorizationHeader(opts: {
  method: string
  url: string
  accountId: string             // realm; e.g. "5637369" or "TSTDRV1234567"
  consumerKey: string
  consumerSecret: string
  tokenId: string
  tokenSecret: string
}): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: opts.consumerKey,
    oauth_token: opts.tokenId,
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_version: "1.0",
  }

  const parsed = new URL(opts.url)
  // NetSuite expects the realm to match the account id with underscores
  // (e.g. 5637369 stays, TSTDRV1234567 stays, hyphens become underscores).
  const realm = opts.accountId.replace(/-/g, "_").toUpperCase()

  // Build the signature base string. Query params and oauth_* params are
  // collected, percent-encoded, sorted, joined with '&' — then concatenated
  // with method + base URL per RFC 5849 §3.4.1.
  const allParams: Array<[string, string]> = []
  parsed.searchParams.forEach((v, k) => allParams.push([k, v]))
  for (const [k, v] of Object.entries(oauthParams)) allParams.push([k, v])

  allParams.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const encodedParams = allParams
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&")
  const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  const baseString = [
    opts.method.toUpperCase(),
    rfc3986(baseUrl),
    rfc3986(encodedParams),
  ].join("&")

  const signingKey = `${rfc3986(opts.consumerSecret)}&${rfc3986(opts.tokenSecret)}`
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(baseString)
  )
  const signature = base64FromBytes(new Uint8Array(sig))

  const headerParams: Record<string, string> = {
    realm,
    ...oauthParams,
    oauth_signature: signature,
  }
  const header =
    "OAuth " +
    Object.entries(headerParams)
      .map(([k, v]) => `${rfc3986(k)}="${rfc3986(v)}"`)
      .join(", ")
  return header
}

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  )
}

// ===========================================================================
// Base64 helpers (Workers-safe — no Buffer)
// ===========================================================================

function base64FromBytes(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  return base64FromBytes(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function base64UrlFromString(s: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(s))
}
