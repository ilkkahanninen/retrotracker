import { describe, expect, it } from "vitest";
import { assertSecureIssuer, readConfig } from "../../server/config.js";

describe("assertSecureIssuer", () => {
  it("accepts https URLs", () => {
    expect(() =>
      assertSecureIssuer("https://tenant.logto.app/oidc"),
    ).not.toThrow();
  });

  it("accepts http://localhost (any flavour)", () => {
    expect(() =>
      assertSecureIssuer("http://localhost:3000/oidc"),
    ).not.toThrow();
    expect(() =>
      assertSecureIssuer("http://127.0.0.1:3000/oidc"),
    ).not.toThrow();
    expect(() => assertSecureIssuer("http://[::1]/oidc")).not.toThrow();
  });

  it("rejects http on a public host", () => {
    expect(() => assertSecureIssuer("http://attacker.test/oidc")).toThrow(
      /https:\/\//,
    );
  });

  it("rejects ftp / file / data schemes", () => {
    expect(() => assertSecureIssuer("ftp://idp.test")).toThrow();
    expect(() => assertSecureIssuer("file:///etc/idp")).toThrow();
    expect(() => assertSecureIssuer("not a url at all")).toThrow();
  });
});

describe("readConfig — quota", () => {
  it("defaults to 100 MB / user when RETROTRACKER_USER_QUOTA_MB is unset", () => {
    const cfg = readConfig("prod", { RETROTRACKER_BACKEND: "1" });
    expect(cfg.userQuotaBytes).toBe(100 * 1024 * 1024);
  });

  it("honours a numeric override", () => {
    const cfg = readConfig("prod", {
      RETROTRACKER_BACKEND: "1",
      RETROTRACKER_USER_QUOTA_MB: "10",
    });
    expect(cfg.userQuotaBytes).toBe(10 * 1024 * 1024);
  });

  it("0 disables the quota", () => {
    const cfg = readConfig("prod", {
      RETROTRACKER_BACKEND: "1",
      RETROTRACKER_USER_QUOTA_MB: "0",
    });
    expect(cfg.userQuotaBytes).toBe(0);
  });

  it("throws on garbage", () => {
    expect(() =>
      readConfig("prod", {
        RETROTRACKER_BACKEND: "1",
        RETROTRACKER_USER_QUOTA_MB: "lots",
      }),
    ).toThrow();
  });
});
