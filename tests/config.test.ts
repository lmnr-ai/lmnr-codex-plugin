import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import { getLaminarConfig, lmnrConfigDir, readLoggedInUserId } from "../src/config.js";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  process.env = { ...ORIGINAL_ENV };
}

describe("Laminar config", () => {
  afterEach(resetEnv);

  it("uses LMNR_USER_ID before the logged-in CLI identity", () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "lmnr-config-"));
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.LMNR_PROJECT_API_KEY = "key";
    process.env.LMNR_USER_ID = "explicit-user";
    fs.mkdirSync(lmnrConfigDir(), { recursive: true });
    fs.writeFileSync(path.join(lmnrConfigDir(), "credentials.json"), JSON.stringify({ userEmail: "cli@example.com" }), "utf-8");

    assert.equal(getLaminarConfig()!.userId, "explicit-user");
  });

  it("falls back to lmnr-cli login credentials, preferring email over user id", () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "lmnr-config-"));
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.LMNR_PROJECT_API_KEY = "key";
    delete process.env.LMNR_USER_ID;
    fs.mkdirSync(lmnrConfigDir(), { recursive: true });
    fs.writeFileSync(
      path.join(lmnrConfigDir(), "credentials.json"),
      JSON.stringify({ userId: "user-123", userEmail: "person@example.com" }),
      "utf-8"
    );

    assert.equal(readLoggedInUserId(), "person@example.com");
    assert.equal(getLaminarConfig()!.userId, "person@example.com");
  });

  it("falls back to CLI userId when userEmail is absent", () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "lmnr-config-"));
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.LMNR_PROJECT_API_KEY = "key";
    delete process.env.LMNR_USER_ID;
    fs.mkdirSync(lmnrConfigDir(), { recursive: true });
    fs.writeFileSync(path.join(lmnrConfigDir(), "credentials.json"), JSON.stringify({ userId: "user-123" }), "utf-8");

    assert.equal(getLaminarConfig()!.userId, "user-123");
  });

  it("does not use CODEX_LMNR_USER_ID as a user-id alias", () => {
    process.env.LMNR_PROJECT_API_KEY = "key";
    delete process.env.LMNR_USER_ID;
    process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lmnr-config-empty-"));
    process.env.CODEX_LMNR_USER_ID = "legacy-alias";

    assert.equal(getLaminarConfig()!.userId, null);
  });
});
