/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpAgent } from "agents/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { NetSuiteService, type NetSuiteAuth } from "./NetSuiteService"
// NSAuthContext is declared globally in types.d.ts

/**
 * Multi-tenant NetSuite MCP server.
 *
 * Every tool takes `slug` as its first input (per the build brief) — the
 * agent resolves the slug to a Durable Object stored in NS_ACCOUNT_STORE,
 * grabs a usable bearer (OAuth M2M) or TBA credential set, and constructs a
 * fresh `NetSuiteService` for the call. The agent itself is stateless across
 * tool invocations beyond what `props.slug` carries from the transport
 * middleware.
 *
 * The 11 v1 tools listed in the brief are:
 *
 *   list_companies                 (slug ignored — global list)
 *   list_subsidiaries
 *   list_bank_accounts
 *   get_unmatched_summary
 *   search_bank_lines
 *   search_account_transactions
 *   find_match_candidates          (ranked by confidence; obvious_only default true)
 *   create_bank_match              (STRICTLY one-to-one; arrays rejected)
 *   exclude_bank_line
 *   unmatch
 *
 * `list_companies` returns the list of registered slugs and is the only tool
 * that doesn't dereference a company DO. The brief explicitly says no clients
 * are onboarded in v1, so this is expected to return an empty list until
 * Saturn onboards Little Words Project.
 */
export class NetSuiteMCP extends McpAgent<Env, unknown, NSAuthContext> {
  async init() {}

  private async authForSlug(slug: string): Promise<NetSuiteAuth> {
    const stubId = this.env.NS_ACCOUNT_STORE.idFromName(slug)
    const stub = this.env.NS_ACCOUNT_STORE.get(stubId)
    const auth = await stub.getAccessToken()
    if (!auth) {
      throw new Error(
        `Company "${slug}" is not onboarded. Use the admin console at /admin to register it first.`
      )
    }
    if (auth.mode === "oauth_m2m") {
      return {
        mode: "oauth_m2m",
        access_token: auth.access_token,
        account_id: auth.account_id,
      }
    }
    // TBA — load the secrets directly from the DO record
    const record = await stub.getRecord()
    if (!record || !record.tba) {
      throw new Error(`Company "${slug}" is in TBA mode but is missing TBA credentials`)
    }
    return {
      mode: "tba",
      account_id: record.account_id,
      consumer_key: record.tba.consumer_key,
      consumer_secret: record.tba.consumer_secret,
      token_id: record.tba.token_id,
      token_secret: record.tba.token_secret,
    }
  }

  private async serviceFor(slug: string): Promise<NetSuiteService> {
    return new NetSuiteService(await this.authForSlug(slug))
  }

  private async listRegisteredSlugs(): Promise<Array<Record<string, unknown>>> {
    // The DO namespace doesn't expose a list operation, so we keep a roster
    // in a sidecar instance under the well-known id "__roster__".
    const rosterId = this.env.NS_ACCOUNT_STORE.idFromName("__roster__")
    const roster = this.env.NS_ACCOUNT_STORE.get(rosterId)
    const slugs = (await roster.listSlugs()) ?? []
    const out: Array<Record<string, unknown>> = []
    for (const s of slugs) {
      const stub = this.env.NS_ACCOUNT_STORE.get(
        this.env.NS_ACCOUNT_STORE.idFromName(s)
      )
      const redacted = await stub.redactedRecord()
      if (redacted) out.push(redacted)
    }
    return out
  }

  formatResponse = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  })

  formatError = (error: unknown) => ({
    content: [
      {
        type: "text" as const,
        text:
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : JSON.stringify(error),
      },
    ],
    isError: true as const,
  })

  get server() {
    const server = new McpServer({ name: "Saturn NetSuite MCP", version: "0.1.0" })
    const slug = z.string().min(1).describe("Company slug (registered via the admin console)")

    // -----------------------------------------------------------------------
    // list_companies — global; slug optional, ignored if present
    // -----------------------------------------------------------------------
    server.registerTool(
      "list_companies",
      {
        description:
          "List all NetSuite companies registered via the admin console. Returns redacted records (slug, display_name, account_id, environment, auth_mode). Returns an empty list in v1 until Saturn onboards Little Words Project.",
        inputSchema: { slug: z.string().optional().describe("Ignored; included for API consistency.") },
      },
      async () => {
        try {
          return this.formatResponse(await this.listRegisteredSlugs())
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    // -----------------------------------------------------------------------
    // list_subsidiaries
    // -----------------------------------------------------------------------
    server.registerTool(
      "list_subsidiaries",
      {
        description:
          "List subsidiaries for a OneWorld NetSuite account. Returns id, name, currency, country, parent, iselimination, isinactive. Empty for non-OneWorld accounts.",
        inputSchema: { slug },
      },
      async ({ slug }) => {
        try {
          const svc = await this.serviceFor(slug)
          const rows = await svc.suiteqlAll(
            `SELECT id, name, country, currency, parent, iselimination, isinactive
             FROM subsidiary
             ORDER BY name`
          )
          return this.formatResponse(rows)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    // -----------------------------------------------------------------------
    // list_bank_accounts
    // -----------------------------------------------------------------------
    server.registerTool(
      "list_bank_accounts",
      {
        description:
          "List bank-type GL accounts (accttype = 'Bank'). Returns id, accountnumber, fullname, currency, subsidiary, isinactive.",
        inputSchema: {
          slug,
          subsidiary_id: z
            .string()
            .optional()
            .describe("Filter to a single subsidiary id (OneWorld accounts)"),
          include_inactive: z.boolean().optional().default(false),
        },
      },
      async ({ slug, subsidiary_id, include_inactive }) => {
        try {
          const svc = await this.serviceFor(slug)
          const where: string[] = ["accttype = 'Bank'"]
          if (!include_inactive) where.push("isinactive = 'F'")
          if (subsidiary_id) where.push(`subsidiary = ${Number(subsidiary_id)}`)
          const rows = await svc.suiteqlAll(
            `SELECT id, accountnumber, fullname, currency, subsidiary, isinactive
             FROM account
             WHERE ${where.join(" AND ")}
             ORDER BY fullname`
          )
          return this.formatResponse(rows)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    // -----------------------------------------------------------------------
    // get_unmatched_summary — counts of unreconciled bank lines per account
    // -----------------------------------------------------------------------
    server.registerTool(
      "get_unmatched_summary",
      {
        description:
          "Return per-bank-account counts and totals of bank statement lines that are not yet matched, optionally scoped to a date range.",
        inputSchema: {
          slug,
          start_date: z.string().optional().describe("YYYY-MM-DD lower bound"),
          end_date: z.string().optional().describe("YYYY-MM-DD upper bound"),
          bank_account_id: z.string().optional().describe("Restrict to a single bank GL account"),
        },
      },
      async ({ slug, start_date, end_date, bank_account_id }) => {
        try {
          const svc = await this.serviceFor(slug)
          const where: string[] = ["bsl.matched = 'F'", "bsl.excluded = 'F'"]
          if (start_date) where.push(`bsl.transactiondate >= TO_DATE('${start_date}','YYYY-MM-DD')`)
          if (end_date) where.push(`bsl.transactiondate <= TO_DATE('${end_date}','YYYY-MM-DD')`)
          if (bank_account_id) where.push(`bsl.account = ${Number(bank_account_id)}`)
          const rows = await svc.suiteqlAll(
            `SELECT bsl.account AS bank_account_id,
                    COUNT(*)    AS unmatched_count,
                    SUM(bsl.amount) AS unmatched_total
             FROM   bankstatementline bsl
             WHERE  ${where.join(" AND ")}
             GROUP BY bsl.account
             ORDER BY unmatched_count DESC`
          )
          return this.formatResponse(rows)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    // -----------------------------------------------------------------------
    // search_bank_lines — bank-feed lines (matched / unmatched / excluded)
    // -----------------------------------------------------------------------
    server.registerTool(
      "search_bank_lines",
      {
        description:
          "Search bank statement lines. Filter by date range, amount range, bank account, status (matched/unmatched/excluded), and memo substring.",
        inputSchema: {
          slug,
          bank_account_id: z.string().optional(),
          start_date: z.string().optional(),
          end_date: z.string().optional(),
          min_amount: z.number().optional(),
          max_amount: z.number().optional(),
          status: z.enum(["matched", "unmatched", "excluded", "any"]).optional().default("unmatched"),
          memo_contains: z.string().optional(),
          limit: z.number().int().positive().max(1000).optional().default(100),
          offset: z.number().int().min(0).optional().default(0),
        },
      },
      async (args) => {
        try {
          const svc = await this.serviceFor(args.slug)
          const where: string[] = []
          if (args.bank_account_id) where.push(`account = ${Number(args.bank_account_id)}`)
          if (args.start_date) where.push(`transactiondate >= TO_DATE('${args.start_date}','YYYY-MM-DD')`)
          if (args.end_date) where.push(`transactiondate <= TO_DATE('${args.end_date}','YYYY-MM-DD')`)
          if (args.min_amount !== undefined) where.push(`amount >= ${args.min_amount}`)
          if (args.max_amount !== undefined) where.push(`amount <= ${args.max_amount}`)
          if (args.memo_contains) where.push(`UPPER(memo) LIKE UPPER('%${sqlEscape(args.memo_contains)}%')`)
          if (args.status === "matched") where.push("matched = 'T'")
          else if (args.status === "unmatched") where.push("matched = 'F'", "excluded = 'F'")
          else if (args.status === "excluded") where.push("excluded = 'T'")
          const page = await svc.suiteql(
            `SELECT id, account, transactiondate, amount, memo, currency,
                    matched, excluded, payee, externalid
             FROM   bankstatementline
             ${where.length ? "WHERE " + where.join(" AND ") : ""}
             ORDER BY transactiondate DESC, id DESC`,
            { limit: args.limit, offset: args.offset }
          )
          return this.formatResponse(page)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    // -----------------------------------------------------------------------
    // search_account_transactions — GL postings against a bank account
    // -----------------------------------------------------------------------
    server.registerTool(
      "search_account_transactions",
      {
        description:
          "Search posted transactions hitting a bank account (transactionaccountingline). Useful for finding the GL side of a match candidate.",
        inputSchema: {
          slug,
          bank_account_id: z.string().describe("Bank GL account id"),
          start_date: z.string().optional(),
          end_date: z.string().optional(),
          min_amount: z.number().optional(),
          max_amount: z.number().optional(),
          memo_contains: z.string().optional(),
          unreconciled_only: z.boolean().optional().default(true),
          limit: z.number().int().positive().max(1000).optional().default(100),
          offset: z.number().int().min(0).optional().default(0),
        },
      },
      async (args) => {
        try {
          const svc = await this.serviceFor(args.slug)
          const where: string[] = [
            `tal.account = ${Number(args.bank_account_id)}`,
            "t.posting = 'T'",
          ]
          if (args.start_date) where.push(`t.trandate >= TO_DATE('${args.start_date}','YYYY-MM-DD')`)
          if (args.end_date) where.push(`t.trandate <= TO_DATE('${args.end_date}','YYYY-MM-DD')`)
          if (args.min_amount !== undefined) where.push(`tal.amount >= ${args.min_amount}`)
          if (args.max_amount !== undefined) where.push(`tal.amount <= ${args.max_amount}`)
          if (args.memo_contains)
            where.push(`UPPER(t.memo) LIKE UPPER('%${sqlEscape(args.memo_contains)}%')`)
          if (args.unreconciled_only) where.push("tal.cleared = 'F'")
          const page = await svc.suiteql(
            `SELECT t.id, t.tranid, t.type, t.trandate, t.memo, t.entity, t.currency,
                    tal.amount, tal.cleared, tal.account
             FROM   transaction t
             JOIN   transactionaccountingline tal ON tal.transaction = t.id
             WHERE  ${where.join(" AND ")}
             ORDER BY t.trandate DESC, t.id DESC`,
            { limit: args.limit, offset: args.offset }
          )
          return this.formatResponse(page)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    // -----------------------------------------------------------------------
    // find_match_candidates — rank GL txns against a single bank line
    // -----------------------------------------------------------------------
    server.registerTool(
      "find_match_candidates",
      {
        description:
          "For a single bank statement line, find candidate GL transactions on the same bank account and rank them by confidence (amount equality, date proximity, memo/payee similarity). When obvious_only=true (default) returns only candidates with confidence >= 0.95.",
        inputSchema: {
          slug,
          bank_line_id: z.string().describe("Bank statement line id to match"),
          date_window_days: z.number().int().positive().max(60).optional().default(7),
          obvious_only: z.boolean().optional().default(true),
          limit: z.number().int().positive().max(50).optional().default(10),
        },
      },
      async (args) => {
        try {
          const svc = await this.serviceFor(args.slug)
          const [bankLine] = await svc.suiteqlAll(
            `SELECT id, account, transactiondate, amount, memo, payee, currency
             FROM   bankstatementline
             WHERE  id = ${Number(args.bank_line_id)}`
          )
          if (!bankLine) throw new Error(`bank line ${args.bank_line_id} not found`)

          const lineDate = String(bankLine.transactiondate).slice(0, 10)
          const lineAmount = Number(bankLine.amount)
          const windowDays = args.date_window_days

          // Pull a generous pool of unreconciled candidates within the window.
          const candidates = await svc.suiteqlAll(
            `SELECT t.id, t.tranid, t.type, t.trandate, t.memo, t.entity,
                    tal.amount
             FROM   transaction t
             JOIN   transactionaccountingline tal ON tal.transaction = t.id
             WHERE  tal.account = ${Number(bankLine.account)}
               AND  tal.cleared = 'F'
               AND  t.posting = 'T'
               AND  t.trandate BETWEEN TO_DATE('${lineDate}','YYYY-MM-DD') - ${windowDays}
                                AND   TO_DATE('${lineDate}','YYYY-MM-DD') + ${windowDays}
             ORDER BY t.trandate DESC`,
            500
          )

          const scored = candidates
            .map((c: any) => {
              const dateDiff = Math.abs(daysBetween(lineDate, String(c.trandate).slice(0, 10)))
              const amountMatch = nearlyEqual(Number(c.amount), lineAmount)
              const memoSim = jaccard(String(bankLine.memo ?? ""), String(c.memo ?? ""))
              const payeeSim = jaccard(String(bankLine.payee ?? ""), String(c.memo ?? ""))
              // Confidence: 0.7 amount match + 0.2 date proximity (within window)
              // + 0.1 best of (memo|payee) similarity.
              const dateScore = Math.max(0, 1 - dateDiff / windowDays)
              const sim = Math.max(memoSim, payeeSim)
              const confidence =
                (amountMatch ? 0.7 : 0) + 0.2 * dateScore + 0.1 * sim
              return {
                transaction_id: c.id,
                tran_id: c.tranid,
                type: c.type,
                date: String(c.trandate).slice(0, 10),
                amount: c.amount,
                memo: c.memo,
                entity: c.entity,
                date_diff_days: dateDiff,
                amount_match: amountMatch,
                memo_similarity: Number(sim.toFixed(3)),
                confidence: Number(confidence.toFixed(3)),
              }
            })
            .filter((c) => !args.obvious_only || c.confidence >= 0.95)
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, args.limit)

          return this.formatResponse({
            bank_line: bankLine,
            candidates: scored,
            obvious_only: args.obvious_only,
          })
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    // -----------------------------------------------------------------------
    // create_bank_match — STRICTLY one-to-one
    // -----------------------------------------------------------------------
    server.registerTool(
      "create_bank_match",
      {
        description:
          "Match a single bank statement line to a single GL transaction line. STRICTLY one-to-one: arrays for either id are rejected by the server. Use repeated calls for bulk operations once a manual review confirms each pair.",
        inputSchema: {
          slug,
          bank_line_id: z.string().describe("Bank statement line id (single value, not an array)"),
          transaction_id: z.string().describe("GL transaction id (single value, not an array)"),
        },
      },
      async (args) => {
        try {
          // Defense-in-depth: arrays are rejected even though the schema is z.string().
          if (
            Array.isArray(args.bank_line_id) ||
            Array.isArray(args.transaction_id) ||
            typeof args.bank_line_id !== "string" ||
            typeof args.transaction_id !== "string"
          ) {
            throw new Error("create_bank_match is strictly one-to-one; arrays are not accepted")
          }

          const svc = await this.serviceFor(args.slug)
          const result = await svc.postRecord("bankStatementLineMatch", {
            bankStatementLine: { id: args.bank_line_id },
            transaction: { id: args.transaction_id },
          })
          return this.formatResponse({ matched: true, result })
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    // -----------------------------------------------------------------------
    // exclude_bank_line
    // -----------------------------------------------------------------------
    server.registerTool(
      "exclude_bank_line",
      {
        description:
          "Mark a bank statement line as excluded (will not appear in unmatched_summary and is skipped by reconciliation).",
        inputSchema: {
          slug,
          bank_line_id: z.string(),
          reason: z.string().optional().describe("Free-text note stored on the line"),
        },
      },
      async ({ slug, bank_line_id, reason }) => {
        try {
          const svc = await this.serviceFor(slug)
          const result = await svc.patchRecord(
            "bankStatementLine",
            bank_line_id,
            { excluded: true, excludedReason: reason ?? null }
          )
          return this.formatResponse({ excluded: true, result })
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    // -----------------------------------------------------------------------
    // unmatch
    // -----------------------------------------------------------------------
    server.registerTool(
      "unmatch",
      {
        description:
          "Undo a previously created bank match. Accepts the bank statement line id; the match record is looked up and deleted.",
        inputSchema: { slug, bank_line_id: z.string() },
      },
      async ({ slug, bank_line_id }) => {
        try {
          const svc = await this.serviceFor(slug)
          // Look up the existing match for this bank line, then delete it.
          const matches = await svc.suiteqlAll(
            `SELECT id FROM bankstatementlinematch WHERE bankstatementline = ${Number(bank_line_id)}`
          )
          if (matches.length === 0) {
            return this.formatResponse({ unmatched: false, reason: "no match on this line" })
          }
          for (const m of matches) {
            await svc.request(`/record/v1/bankStatementLineMatch/${m.id}`, {
              method: "DELETE",
            } as any)
          }
          return this.formatResponse({ unmatched: true, deleted: matches.length })
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    return server
  }
}

// ---------------------------------------------------------------------------
// Helpers (local to NetSuiteMCP)
// ---------------------------------------------------------------------------

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''")
}

function daysBetween(a: string, b: string): number {
  const da = Date.parse(a)
  const db = Date.parse(b)
  return Math.round((db - da) / 86_400_000)
}

function nearlyEqual(a: number, b: number, epsilon = 0.005): boolean {
  return Math.abs(a - b) <= epsilon
}

function jaccard(a: string, b: string): number {
  const ta = new Set(tokenize(a))
  const tb = new Set(tokenize(b))
  if (ta.size === 0 && tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / (ta.size + tb.size - inter)
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2)
}
