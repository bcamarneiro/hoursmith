/**
 * Session validation middleware for Hoursmith API routes.
 *
 * Validates a Supabase JWT against the GoTrue server (DB-backed verification),
 * looks up the user's active subscription, and returns structured session data.
 * Rejects requests with missing, expired, tampered, or globally signed-out
 * tokens before they reach route handlers.
 *
 * Designed for Vercel Edge Functions (runtime: 'edge'). All heavy dependencies
 * are injectable so tests can supply lightweight mocks.
 *
 * ## Usage
 *
 * ```ts
 * import { withSession } from "../_lib/session";
 *
 * export default withSession(async (req, session) => {
 *   // session is { userId, email, stripeCustomerId, subscriptionActive, ... }
 *   return new Response(JSON.stringify({ ok: true }));
 * });
 * ```
 */

import { userIdFromToken, emailFromToken } from "./auth";
import type {
  SupabaseAdminClient,
  SubscriptionRow,
} from "./supabaseAdmin";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The result of a successful session validation. */
export interface SessionData {
  /** The authenticated user's Supabase UUID. */
  userId: string;
  /** The user's email address. */
  email: string;
  /**
   * Stripe/Polar customer ID for billing lookups, or `null` when the user has
   * no subscription row yet (e.g. pre-checkout).
   */
  stripeCustomerId: string | null;
  /**
   * Whether the user currently has an active (paid) subscription.
   *
   * `true`  → `subscriptions.status IN ('trialing', 'active', 'past_due')`.
   * `false` → no subscription row, or status is cancelled/unpaid/incomplete.
   */
  subscriptionActive: boolean;
  /**
   * Subscription tier (`free` or `premium`), or `null` when no subscription
   * row exists.
   */
  tier: string | null;
  /**
   * The subscription's current period end as a Unix timestamp (seconds), or
   * `null` when there is no active subscription.
   */
  currentPeriodEnd: number | null;
}

export interface SessionValidationOptions {
  /**
   * Inject a Supabase admin client for subscription lookups.
   * The constructor must receive the service-role key so queries run with
   * elevated privileges (RLS bypass).
   */
  supabaseAdmin?: SupabaseAdminClient;
  /**
   * Override token extraction. Default reads the `Authorization` header
   * (`Bearer <token>`).
   */
  getToken?: (req: Request) => string | null;
  /**
   * Override token verification. Default uses `userIdFromToken` from
   * `auth.ts` which validates the JWT against the GoTrue server (not just
   * local JWKS) — this catches globally signed-out tokens.
   */
  verifyToken?: (token: string) => Promise<string | null>;
  /**
   * Override email resolution. Default uses `emailFromToken` which calls
   * GoTrue's `/auth/v1/user` endpoint with the service-role key.
   */
  resolveEmail?: (token: string) => Promise<string | null>;
}

/** Union result: either a Response (error) or SessionData (success). */
export type SessionResult =
  | { type: "error"; response: Response }
  | { type: "ok"; session: SessionData };

// ---------------------------------------------------------------------------
// Token extraction (default)
// ---------------------------------------------------------------------------

function extractBearer(req: Request): string | null {
  const header =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header) return null;
  // Handle "Bearer <token>" and "bearer <token>"
  const m = /^\s*bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Subscription helper
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = new Set(["trialing", "active", "past_due"]);

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

/**
 * Validate the request's JWT and resolve session data.
 *
 * On failure (missing token, invalid token) returns an
 * `{ type: "error"; response }` result. The caller should return the
 * response directly (it already has the correct status code and JSON body).
 *
 * On success returns `{ type: "ok"; session }` with user and subscription
 * data.
 */
export async function validateSession(
  req: Request,
  opts: SessionValidationOptions = {},
): Promise<SessionResult> {
  const {
    supabaseAdmin,
    getToken = extractBearer,
    verifyToken = (token: string) => userIdFromToken(token),
    resolveEmail = (token: string) => emailFromToken(token),
  } = opts;

  // 1. Extract token
  const token = getToken(req);
  if (!token) {
    return {
      type: "error",
      response: new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    };
  }

  // 2. Verify token (GoTrue server check — catches revoked tokens)
  let userId: string | null;
  try {
    userId = await verifyToken(token);
  } catch {
    return {
      type: "error",
      response: new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    };
  }

  if (!userId) {
    return {
      type: "error",
      response: new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    };
  }

  // 3. Resolve email
  let email: string;
  try {
    const e = await resolveEmail(token);
    if (!e) {
      return {
        type: "error",
        response: new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      };
    }
    email = e;
  } catch {
    return {
      type: "error",
      response: new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    };
  }

  // 4. Look up subscription (best-effort — non-blocking)
  let sub: SubscriptionRow | null = null;
  if (supabaseAdmin) {
    try {
      sub = await supabaseAdmin.getSubscription(userId);
    } catch (err) {
      // Subscription lookup is non-blocking. If it fails, we still have a
      // valid session; the caller can decide what to do.
      console.warn(
        `Session: subscription lookup failed for user ${userId}`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const stripeCustomerId = sub?.stripe_customer_id ?? null;
  const subscriptionActive = sub ? ACTIVE_STATUSES.has(sub.status) : false;
  const tier = sub?.tier ?? null;
  const currentPeriodEnd = sub?.current_period_end
    ? new Date(sub.current_period_end).getTime() / 1000
    : null;

  return {
    type: "ok",
    session: {
      userId,
      email,
      stripeCustomerId,
      subscriptionActive,
      tier,
      currentPeriodEnd,
    },
  };
}

// ---------------------------------------------------------------------------
// Higher-order wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a route handler so that every request is session-validated before the
 * handler executes. The `session` is passed as the second argument.
 *
 * ```ts
 * export default withSession(async (req, session) => {
 *   if (!session.subscriptionActive) {
 *     return new Response(JSON.stringify({ error: "No subscription" }), { status: 402 });
 *   }
 *   // … handle the request …
 * });
 * ```
 *
 * @param handler  The route handler receiving `(req, session)`.
 * @param opts     Injection overrides for testing.
 */
export function withSession(
  handler: (
    req: Request,
    session: SessionData,
  ) => Promise<Response> | Response,
  opts?: SessionValidationOptions,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const result = await validateSession(req, opts);
    if (result.type === "error") return result.response;
    return handler(req, result.session);
  };
}
