/* eslint-disable @typescript-eslint/no-explicit-any */
import { DurableObject } from "cloudflare:workers"
import {
  exchangeJwtForAccessToken,
  generateRsaKeypair,
  signNetSuiteClientAssertion,
} from "./lib/auth"

/**
 * Per-company Durable Object holding the onboarding record (account id,
 * environment, OAuth M2M or TBA credentials, generated RSA-2048 keypair) and
 * a short-lived OAuth access-token cache. There is exactly one instance per
 * company slug; ids are derived via `idFromName(slug)`.
 *
 * Layout (DO storage keys):
 *   "record"               -> CompanyRecord
 *   "token"                -> CachedAccessToken    (refreshed on expiry)
 *   "pending_keypair"      -> { privateJwk, publicPem, publicJwk, generated_at }
 *
 * `pending_keypair` is set by /admin/api/keypair before the operator submits
 * the onboarding form. When the form is submitted, the pending key is moved
 * into the company record and the pending slot is cleared.
 */
export class NetSuiteAccountStore extends DurableObject<Env> {
  async getRecord(): Promise<CompanyRecord | null> {
    return (await this.ctx.storage.get<CompanyRecord>("record")) ?? null
  }

  async putRecord(record: CompanyRecord): Promise<void> {
    await this.ctx.storage.put("record", record)
    // Wipe any cached token — credentials may have changed.
    await this.ctx.storage.delete("token")
  }

  async deleteRecord(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }

  // -------------------------------------------------------------------------
  // Roster — global slug list, kept on the well-known "__roster__" instance.
  // Any other instance ignores these methods.
  // -------------------------------------------------------------------------

  async listSlugs(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>("__roster_slugs__")) ?? []
  }

  async addSlug(slug: string): Promise<void> {
    const current = await this.listSlugs()
    if (!current.includes(slug)) {
      current.push(slug)
      current.sort()
      await this.ctx.storage.put("__roster_slugs__", current)
    }
  }

  async removeSlug(slug: string): Promise<void> {
    const current = await this.listSlugs()
    const next = current.filter((s) => s !== slug)
    if (next.length !== current.length) {
      await this.ctx.storage.put("__roster_slugs__", next)
    }
  }

  /**
   * Generate a fresh RSA-2048 keypair and stash the private half for the
   * pending onboarding submission. Returns the public PEM so the operator
   * can upload it to NetSuite's certificate management UI.
   */
  async generateKeypair(): Promise<{ public_pem: string; generated_at: number }> {
    const { privateJwk, publicPem, publicJwk } = await generateRsaKeypair()
    const generated_at = Date.now()
    await this.ctx.storage.put("pending_keypair", {
      privateJwk,
      publicPem,
      publicJwk,
      generated_at,
    })
    return { public_pem: publicPem, generated_at }
  }

  async consumePendingKeypair(): Promise<{
    privateJwk: JsonWebKey
    publicPem: string
    publicJwk: JsonWebKey
  } | null> {
    const pending = await this.ctx.storage.get<{
      privateJwk: JsonWebKey
      publicPem: string
      publicJwk: JsonWebKey
      generated_at: number
    }>("pending_keypair")
    if (!pending) return null
    await this.ctx.storage.delete("pending_keypair")
    return pending
  }

  async peekPendingKeypair(): Promise<{ public_pem: string; generated_at: number } | null> {
    const pending = await this.ctx.storage.get<{
      publicPem: string
      generated_at: number
    }>("pending_keypair")
    if (!pending) return null
    return { public_pem: pending.publicPem, generated_at: pending.generated_at }
  }

  /**
   * Return a usable access token for the company, refreshing it via OAuth
   * M2M (JWT Bearer, PS256) if the cached token is missing or expiring
   * within the next 60 seconds. For TBA-mode companies, returns null —
   * the caller will sign each request individually.
   */
  async getAccessToken(): Promise<{
    mode: "oauth_m2m"
    access_token: string
    account_id: string
    environment: "production" | "sandbox"
  } | {
    mode: "tba"
    account_id: string
    environment: "production" | "sandbox"
  } | null> {
    const record = await this.getRecord()
    if (!record) return null

    if (record.auth_mode === "tba") {
      return {
        mode: "tba",
        account_id: record.account_id,
        environment: record.environment,
      }
    }

    if (!record.oauth || !record.oauth.certificate_id) {
      throw new Error(
        "Company is configured for OAuth M2M but the certificate_id has not been set. " +
          "Upload the public key in NetSuite, then update the company record with certificate_id."
      )
    }

    const cached = await this.ctx.storage.get<CachedAccessToken>("token")
    if (cached && cached.expires_at > Date.now() + 60_000) {
      return {
        mode: "oauth_m2m",
        access_token: cached.access_token,
        account_id: record.account_id,
        environment: record.environment,
      }
    }

    const tokenUrl = netSuiteTokenUrl(record.account_id, record.environment)
    const assertion = await signNetSuiteClientAssertion({
      consumerKey: record.oauth.consumer_key,
      certificateId: record.oauth.certificate_id,
      privateJwk: record.oauth.private_key_jwk,
      tokenUrl,
    })
    const token = await exchangeJwtForAccessToken({
      tokenUrl,
      clientAssertion: assertion,
      scope: record.oauth.scope ?? "rest_webservices",
    })
    const cacheEntry: CachedAccessToken = {
      access_token: token.access_token,
      token_type: token.token_type,
      expires_at: Date.now() + token.expires_in * 1000,
      scope: token.scope,
    }
    await this.ctx.storage.put("token", cacheEntry)
    return {
      mode: "oauth_m2m",
      access_token: token.access_token,
      account_id: record.account_id,
      environment: record.environment,
    }
  }

  /**
   * Expose a redacted snapshot of the company record for admin display.
   * Never returns the private JWK or TBA secrets.
   */
  async redactedRecord(): Promise<Record<string, unknown> | null> {
    const record = await this.getRecord()
    if (!record) return null
    return {
      slug: record.slug,
      display_name: record.display_name,
      account_id: record.account_id,
      environment: record.environment,
      is_oneworld: record.is_oneworld,
      primary_subsidiary_id: record.primary_subsidiary_id,
      default_currency: record.default_currency,
      auth_mode: record.auth_mode,
      oauth_consumer_key: record.oauth?.consumer_key,
      oauth_certificate_id: record.oauth?.certificate_id,
      tba_consumer_key: record.tba?.consumer_key,
      tba_token_id: record.tba?.token_id,
      created_at: record.created_at,
      updated_at: record.updated_at,
    }
  }
}

/** Build the OAuth token endpoint URL for a NetSuite account. */
export function netSuiteTokenUrl(
  accountId: string,
  environment: "production" | "sandbox"
): string {
  // NetSuite OAuth endpoint format:
  //   https://{account-id}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token
  // Account ids with underscores are kept as-is; sandbox accounts already include "_SB1" etc.
  const host = `${accountId.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`
  void environment // accountId already encodes prod vs sandbox in NS conventions
  return `https://${host}/services/rest/auth/oauth2/v1/token`
}

/** Build the REST + SuiteQL base URL for a NetSuite account. */
export function netSuiteRestBase(accountId: string): string {
  const host = `${accountId.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`
  return `https://${host}/services/rest`
}
