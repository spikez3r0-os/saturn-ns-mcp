/* eslint-disable @typescript-eslint/no-explicit-any */
import { netSuiteRestBase } from "./NetSuiteAccountStore"
import { buildTbaAuthorizationHeader } from "./lib/auth"

/**
 * Fetch-based NetSuite SuiteTalk REST + SuiteQL client.
 *
 * Authentication is resolved at construction time by `getAuthFor(slug)` in
 * the McpAgent: for OAuth M2M companies we hold a short-lived bearer token;
 * for TBA companies we hold the four OAuth 1.0a secrets and sign each
 * request inline.
 *
 * Endpoints:
 *   GET  /services/rest/record/v1/{type}/{id}
 *   POST /services/rest/record/v1/{type}
 *   POST /services/rest/query/v1/suiteql        (SuiteQL)
 */
export type NetSuiteAuth =
  | {
      mode: "oauth_m2m"
      access_token: string
      account_id: string
    }
  | {
      mode: "tba"
      account_id: string
      consumer_key: string
      consumer_secret: string
      token_id: string
      token_secret: string
    }

export class NetSuiteService {
  constructor(private readonly auth: NetSuiteAuth) {}

  private get baseUrl(): string {
    return netSuiteRestBase(this.auth.account_id)
  }

  private async authHeader(method: string, url: string): Promise<string> {
    if (this.auth.mode === "oauth_m2m") {
      return `Bearer ${this.auth.access_token}`
    }
    return buildTbaAuthorizationHeader({
      method,
      url,
      accountId: this.auth.account_id,
      consumerKey: this.auth.consumer_key,
      consumerSecret: this.auth.consumer_secret,
      tokenId: this.auth.token_id,
      tokenSecret: this.auth.token_secret,
    })
  }

  async request(
    path: string,
    init: RequestInit & { prefer?: string } = {}
  ): Promise<any> {
    const url = `${this.baseUrl}${path}`
    const method = (init.method || "GET").toUpperCase()
    const headers: Record<string, string> = {
      Authorization: await this.authHeader(method, url),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.prefer ? { Prefer: init.prefer } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    }
    const res = await fetch(url, { ...init, method, headers })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`NetSuite API ${method} ${path} failed (${res.status}): ${text}`)
    }
    if (res.status === 204) return null
    const ct = res.headers.get("content-type") || ""
    if (ct.includes("application/json")) return res.json()
    return res.text()
  }

  // -------------------------------------------------------------------------
  // SuiteTalk REST
  // -------------------------------------------------------------------------

  async getRecord(type: string, id: string): Promise<any> {
    return this.request(`/record/v1/${type}/${encodeURIComponent(id)}`)
  }

  async postRecord(type: string, body: Record<string, any>): Promise<any> {
    return this.request(`/record/v1/${type}`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  async patchRecord(type: string, id: string, body: Record<string, any>): Promise<any> {
    return this.request(`/record/v1/${type}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    })
  }

  // -------------------------------------------------------------------------
  // SuiteQL — read-only analytical queries
  // -------------------------------------------------------------------------

  /**
   * Run a SuiteQL query. NetSuite paginates via `?limit=&offset=`; defaults
   * to 100 rows per page, max 1000. `Prefer: transient` avoids cursoring on
   * the server side which we don't need.
   */
  async suiteql(
    query: string,
    opts: { limit?: number; offset?: number } = {}
  ): Promise<{ items: any[]; hasMore: boolean; totalResults?: number }> {
    const params = new URLSearchParams()
    if (opts.limit) params.set("limit", String(opts.limit))
    if (opts.offset) params.set("offset", String(opts.offset))
    const qs = params.toString()
    const path = `/query/v1/suiteql${qs ? `?${qs}` : ""}`
    const res = await this.request(path, {
      method: "POST",
      body: JSON.stringify({ q: query }),
      prefer: "transient",
    })
    return {
      items: res.items ?? [],
      hasMore: !!res.hasMore,
      totalResults: res.totalResults,
    }
  }

  /** SuiteQL helper that auto-paginates until exhausted (max 5,000 rows). */
  async suiteqlAll(query: string, hardCap = 5_000): Promise<any[]> {
    const out: any[] = []
    let offset = 0
    const pageSize = 1000
    while (out.length < hardCap) {
      const page = await this.suiteql(query, { limit: pageSize, offset })
      out.push(...page.items)
      if (!page.hasMore || page.items.length < pageSize) break
      offset += pageSize
    }
    return out
  }
}
