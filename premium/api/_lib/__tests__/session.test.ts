import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateSession, withSession } from "../session";
import type { SessionData, SessionValidationOptions } from "../session";
import type { SupabaseAdminClient, SubscriptionRow } from "../supabaseAdmin";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(headers: Record<string, string> = {}) {
  return new Request("https://example.com/api/test", { headers });
}

function reqWithBearer(token: string) {
  return req({ Authorization: `Bearer ${token}` });
}

function subRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    user_id: "user-1",
    stripe_customer_id: "cus_abc123",
    stripe_subscription_id: "sub_xyz",
    tier: "premium",
    status: "active",
    current_period_end: "2026-12-31T23:59:59Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateSession
// ---------------------------------------------------------------------------

describe("validateSession", () => {
  let mockAdmin: SupabaseAdminClient;

  beforeEach(() => {
    mockAdmin = {
      getProfile: vi.fn(),
      getSubscription: vi.fn(),
      getSubscriptionByCustomerId: vi.fn(),
      getUserIdFromToken: vi.fn(),
      insertIncompleteSubscription: vi.fn(),
      upsertSubscription: vi.fn(),
      deleteSubscription: vi.fn(),
      deleteProfile: vi.fn(),
      deleteAuthUser: vi.fn(),
      signOutUser: vi.fn(),
      insertAuditLog: vi.fn(),
      recordBillingEvent: vi.fn(),
    };
  });

  describe("missing token", () => {
    it("returns 401 when Authorization header is absent", async () => {
      const r = await validateSession(req({}));
      expect(r.type).toBe("error");
      expect(r.type === "error" && r.response.status).toBe(401);
      const body = await (r.type === "error" ? r.response.json() : {});
      expect(body.error).toBe("Missing Authorization header");
    });

    it("returns 401 when Authorization header has no Bearer prefix", async () => {
      const r = await validateSession(req({ Authorization: "something" }));
      expect(r.type).toBe("error");
      expect(r.type === "error" && r.response.status).toBe(401);
    });

    it("returns 401 when Authorization header is empty", async () => {
      const r = await validateSession(req({ Authorization: "" }));
      expect(r.type).toBe("error");
      expect(r.type === "error" && r.response.status).toBe(401);
    });
  });

  describe("custom getToken", () => {
    it("uses the injected getToken function", async () => {
      const getToken = vi.fn().mockReturnValue("custom-token");
      const verifyToken = vi.fn().mockResolvedValue("user-1");
      const resolveEmail = vi.fn().mockResolvedValue("test@example.com");

      const r = await validateSession(req({}), {
        getToken,
        verifyToken,
        resolveEmail,
      });

      expect(getToken).toHaveBeenCalled();
      expect(verifyToken).toHaveBeenCalledWith("custom-token");
      expect(r.type).toBe("ok");
    });
  });

  describe("token verification", () => {
    it("returns 401 when verifyToken returns null", async () => {
      const verifyToken = vi.fn().mockResolvedValue(null);
      const resolveEmail = vi.fn();

      const r = await validateSession(reqWithBearer("bad-token"), {
        verifyToken,
        resolveEmail,
      });

      expect(r.type).toBe("error");
      expect(r.type === "error" && r.response.status).toBe(401);
      expect(resolveEmail).not.toHaveBeenCalled();
    });

    it("returns 401 when verifyToken throws", async () => {
      const verifyToken = vi.fn().mockRejectedValue(new Error("boom"));

      const r = await validateSession(reqWithBearer("bad-token"), {
        verifyToken,
      });

      expect(r.type).toBe("error");
      expect(r.type === "error" && r.response.status).toBe(401);
    });

    it("passes token from Bearer header to verifyToken", async () => {
      const verifyToken = vi.fn().mockResolvedValue("user-1");
      const resolveEmail = vi.fn().mockResolvedValue("test@example.com");

      const r = await validateSession(reqWithBearer("abc.def.ghi"), {
        verifyToken,
        resolveEmail,
      });

      expect(verifyToken).toHaveBeenCalledWith("abc.def.ghi");
      expect(r.type).toBe("ok");
    });

    it("handles lowercase bearer prefix", async () => {
      const verifyToken = vi.fn().mockResolvedValue("user-1");
      const resolveEmail = vi.fn().mockResolvedValue("test@example.com");

      const r = await validateSession(
        req({ authorization: "bearer lowercase-token" }),
        { verifyToken, resolveEmail },
      );

      expect(verifyToken).toHaveBeenCalledWith("lowercase-token");
      expect(r.type).toBe("ok");
    });
  });

  describe("email resolution", () => {
    it("returns 401 when resolveEmail returns null", async () => {
      const verifyToken = vi.fn().mockResolvedValue("user-1");
      const resolveEmail = vi.fn().mockResolvedValue(null);

      const r = await validateSession(reqWithBearer("valid-token"), {
        verifyToken,
        resolveEmail,
      });

      expect(r.type).toBe("error");
      expect(r.type === "error" && r.response.status).toBe(401);
    });

    it("returns 401 when resolveEmail throws", async () => {
      const verifyToken = vi.fn().mockResolvedValue("user-1");
      const resolveEmail = vi.fn().mockRejectedValue(new Error("network"));

      const r = await validateSession(reqWithBearer("valid-token"), {
        verifyToken,
        resolveEmail,
      });

      expect(r.type).toBe("error");
      expect(r.type === "error" && r.response.status).toBe(401);
    });

    it("includes email in session data on success", async () => {
      const verifyToken = vi.fn().mockResolvedValue("user-1");
      const resolveEmail = vi.fn().mockResolvedValue("alice@example.com");

      const r = await validateSession(reqWithBearer("valid-token"), {
        verifyToken,
        resolveEmail,
      });

      expect(r.type).toBe("ok");
      expect(r.type === "ok" && r.session.email).toBe("alice@example.com");
    });
  });

  describe("subscription lookup", () => {
    it("returns inactive subscription when supabaseAdmin is not injected", async () => {
      const verifyToken = vi.fn().mockResolvedValue("user-1");
      const resolveEmail = vi.fn().mockResolvedValue("test@example.com");

      const r = await validateSession(reqWithBearer("valid-token"), {
        verifyToken,
        resolveEmail,
      });

      expect(r.type).toBe("ok");
      if (r.type === "ok") {
        expect(r.session.subscriptionActive).toBe(false);
        expect(r.session.stripeCustomerId).toBeNull();
        expect(r.session.tier).toBeNull();
        expect(r.session.currentPeriodEnd).toBeNull();
      }
    });

    it("returns active subscription data from DB", async () => {
      const verifyToken = vi.fn().mockResolvedValue("user-1");
      const resolveEmail = vi.fn().mockResolvedValue("test@example.com");
      (mockAdmin.getSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(
        subRow(),
      );

      const r = await validateSession(reqWithBearer("valid-token"), {
        supabaseAdmin: mockAdmin,
        verifyToken,
        resolveEmail,
      });

      expect(mockAdmin.getSubscription).toHaveBeenCalledWith("user-1");
      expect(r.type).toBe("ok");
      if (r.type === "ok") {
        expect(r.session.subscriptionActive).toBe(true);
        expect(r.session.stripeCustomerId).toBe("cus_abc123");
        expect(r.session.tier).toBe("premium");
        expect(r.session.currentPeriodEnd).toBeGreaterThan(0);
      }
    });

    it("returns inactive for cancelled subscription", async () => {
      const verifyToken = vi.fn().mockResolvedValue("user-1");
      const resolveEmail = vi.fn().mockResolvedValue("test@example.com");
      (mockAdmin.getSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(
        subRow({ status: "cancelled" }),
      );

      const r = await validateSession(reqWithBearer("valid-token"), {
        supabaseAdmin: mockAdmin,
        verifyToken,
        resolveEmail,
      });

      expect(r.type).toBe("ok");
      if (r.type === "ok") {
        expect(r.session.subscriptionActive).toBe(false);
      }
    });

    it("treats 'trialing' as active", async () => {
      const verifyToken = vi.fn().mockResolvedValue("user-1");
      const resolveEmail = vi.fn().mockResolvedValue("test@example.com");
      (mockAdmin.getSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(
        subRow({ status: "trialing" }),
      );

      const r = await validateSession(reqWithBearer("valid-token"), {
        supabaseAdmin: mockAdmin,
        verifyToken,
        resolveEmail,
      });

      expect(r.type).toBe("ok");
      if (r.type === "ok") {
        expect(r.session.subscriptionActive).toBe(true);
      }
    });

    it("treats 'past_due' as active", async () => {
      const verifyToken = vi.fn().mockResolvedValue("user-1");
      const resolveEmail = vi.fn().mockResolvedValue("test@example.com");
      (mockAdmin.getSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(
        subRow({ status: "past_due" }),
      );

      const r = await validateSession(reqWithBearer("valid-token"), {
        supabaseAdmin: mockAdmin,
        verifyToken,
        resolveEmail,
      });

      expect(r.type).toBe("ok");
      if (r.type === "ok") {
        expect(r.session.subscriptionActive).toBe(true);
      }
    });

    it("returns null tier when no subscription row exists", async () => {
      const verifyToken = vi.fn().mockResolvedValue("user-1");
      const resolveEmail = vi.fn().mockResolvedValue("test@example.com");
      (mockAdmin.getSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(
        null,
      );

      const r = await validateSession(reqWithBearer("valid-token"), {
        supabaseAdmin: mockAdmin,
        verifyToken,
        resolveEmail,
      });

      expect(r.type).toBe("ok");
      if (r.type === "ok") {
        expect(r.session.tier).toBeNull();
        expect(r.session.subscriptionActive).toBe(false);
      }
    });

    it("survives subscription lookup failures gracefully", async () => {
      const verifyToken = vi.fn().mockResolvedValue("user-1");
      const resolveEmail = vi.fn().mockResolvedValue("test@example.com");
      (mockAdmin.getSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("DB down"),
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const r = await validateSession(reqWithBearer("valid-token"), {
        supabaseAdmin: mockAdmin,
        verifyToken,
        resolveEmail,
      });

      // Session should still be valid — subscription is non-blocking
      expect(r.type).toBe("ok");
      if (r.type === "ok") {
        expect(r.session.subscriptionActive).toBe(false);
        expect(r.session.userId).toBe("user-1");
      }

      // Should log a warning so ops can detect subscription lookup failures
      expect(warnSpy).toHaveBeenCalledWith(
        "Session: subscription lookup failed for user user-1",
        "DB down",
      );

      warnSpy.mockRestore();
    });

    it("returns null currentPeriodEnd when column is null", async () => {
      const verifyToken = vi.fn().mockResolvedValue("user-1");
      const resolveEmail = vi.fn().mockResolvedValue("test@example.com");
      (mockAdmin.getSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(
        subRow({ current_period_end: null }),
      );

      const r = await validateSession(reqWithBearer("valid-token"), {
        supabaseAdmin: mockAdmin,
        verifyToken,
        resolveEmail,
      });

      expect(r.type).toBe("ok");
      if (r.type === "ok") {
        expect(r.session.currentPeriodEnd).toBeNull();
      }
    });
  });

  describe("default dependencies (integration smoke)", () => {
    it("rejects tokens that fail verifyToken without mocking", async () => {
      // The real verifyToken (userIdFromToken) will fail because there's no
      // Supabase server to talk to. We just want to ensure the plumbing works.
      const r = await validateSession(reqWithBearer("not-a-real-jwt"));
      expect(r.type).toBe("error");
      expect(r.type === "error" && r.response.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// withSession
// ---------------------------------------------------------------------------

describe("withSession", () => {
  let mockAdmin: SupabaseAdminClient;

  beforeEach(() => {
    mockAdmin = {
      getProfile: vi.fn(),
      getSubscription: vi.fn(),
      getSubscriptionByCustomerId: vi.fn(),
      getUserIdFromToken: vi.fn(),
      insertIncompleteSubscription: vi.fn(),
      upsertSubscription: vi.fn(),
      deleteSubscription: vi.fn(),
      deleteProfile: vi.fn(),
      deleteAuthUser: vi.fn(),
      signOutUser: vi.fn(),
      insertAuditLog: vi.fn(),
      recordBillingEvent: vi.fn(),
    };
  });

  it("passes session to wrapped handler on valid token", async () => {
    const verifyToken = vi.fn().mockResolvedValue("user-1");
    const resolveEmail = vi.fn().mockResolvedValue("alice@example.com");
    (mockAdmin.getSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(
      subRow(),
    );

    const handler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true })),
    );

    const wrapped = withSession(handler, {
      supabaseAdmin: mockAdmin,
      verifyToken,
      resolveEmail,
    });

    const response = await wrapped(reqWithBearer("valid-token"));

    expect(handler).toHaveBeenCalledTimes(1);
    const session: SessionData = handler.mock.calls[0][1];
    expect(session.userId).toBe("user-1");
    expect(session.email).toBe("alice@example.com");
    expect(session.subscriptionActive).toBe(true);
    expect(response.status).toBe(200);
  });

  it("returns 401 without calling handler when token is missing", async () => {
    const handler = vi.fn();

    const wrapped = withSession(handler);

    const response = await wrapped(req({}));
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 401 without calling handler when token is invalid", async () => {
    const verifyToken = vi.fn().mockResolvedValue(null);
    const handler = vi.fn();

    const wrapped = withSession(handler, { verifyToken });

    const response = await wrapped(reqWithBearer("bad-token"));
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes through the handler's response", async () => {
    const verifyToken = vi.fn().mockResolvedValue("user-1");
    const resolveEmail = vi.fn().mockResolvedValue("test@example.com");

    const wrapped = withSession(
      async () => new Response("custom body", { status: 418 }),
      { verifyToken, resolveEmail },
    );

    const response = await wrapped(reqWithBearer("valid-token"));
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("custom body");
  });

  it("works when handler throws (propagates the error)", async () => {
    const verifyToken = vi.fn().mockResolvedValue("user-1");
    const resolveEmail = vi.fn().mockResolvedValue("test@example.com");

    const wrapped = withSession(
      async () => {
        throw new Error("handler crash");
      },
      { verifyToken, resolveEmail },
    );

    await expect(wrapped(reqWithBearer("valid-token"))).rejects.toThrow(
      "handler crash",
    );
  });
});
