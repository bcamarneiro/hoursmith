/**
 * Build-time feature flags.
 *
 * Unlike the runtime kill switches (Vercel Edge Config, see `useFlags`), these
 * are compile-time constants for product capabilities gated at deploy time, not
 * toggled per-user. Flipping one is a one-line change + redeploy.
 */

/**
 * The Lead tier is sold-but-unbuilt (ADA-358) with no delivery date, so it is
 * hidden everywhere until it actually ships — we advertise Free + Hosted only.
 *
 * A build constant (not a runtime flag) on purpose: the Pricing/Home pages are
 * public and render in the free/static build, which has no flags endpoint — a
 * runtime flag would flash Lead before hiding it, and "is Lead built & for
 * sale" is a deploy-time fact, not a per-user experiment. Flip to `true` (or
 * wire to Edge Config) when Lead ships. See ADA-376.
 *
 * Typed `boolean` (not the literal `false`) so the gated branches aren't seen
 * as dead code by the type checker / linter.
 *
 * NOTE: the checkout Edge function keeps its own mirror of this constant
 * (`premium/api/checkout/index.ts`) because it can't import frontend code into
 * the edge bundle — keep the two in sync.
 */
export const LEAD_TIER_ENABLED: boolean = false;
