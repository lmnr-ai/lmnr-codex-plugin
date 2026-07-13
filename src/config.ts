import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ----------------- Configuration -----------------
/** Read a plain env var option. */
export function opt(name: string): string {
  return process.env[name] || "";
}

/** Directory where `lmnr-cli login` stores credentials (mirrors the CLI's resolution). */
export function lmnrConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return path.join(xdg, "lmnr");
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "lmnr");
  }
  return path.join(os.homedir(), ".config", "lmnr");
}

/**
 * User identity persisted by `lmnr-cli login` (RFC 8628 device flow), so a
 * logged-in user is attributed with zero config. Returns the stored email
 * (preferred) or user id, or null if not logged in / unreadable (fail-open).
 */
export function readLoggedInUserId(): string | null {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(lmnrConfigDir(), "credentials.json"), "utf-8"));
    if (typeof creds !== "object" || creds === null) {
      return null;
    }
    if (typeof creds.userEmail === "string" && creds.userEmail) {
      return creds.userEmail;
    }
    return typeof creds.userId === "string" && creds.userId ? creds.userId : null;
  } catch {
    return null;
  }
}

/**
 * Laminar plugin config written by `lmnr-cli plugin add codex`
 * (`~/.config/lmnr/codex-plugin.json`). This is the primary source for the
 * project API key: Codex has no per-plugin secret store, so both the Codex and
 * Claude Code plugins share this file convention. Plain, unencrypted, read
 * fail-open (missing/unreadable → {}).
 */
function readAgentPluginConfig(): { projectApiKey?: string; baseUrl?: string } {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(lmnrConfigDir(), "codex-plugin.json"), "utf-8"),
    );
    if (typeof raw !== "object" || raw === null) {
      return {};
    }
    const out: { projectApiKey?: string; baseUrl?: string } = {};
    if (typeof raw.projectApiKey === "string" && raw.projectApiKey) {
      out.projectApiKey = raw.projectApiKey;
    }
    if (typeof raw.baseUrl === "string" && raw.baseUrl) {
      out.baseUrl = raw.baseUrl;
    }
    return out;
  } catch {
    return {};
  }
}

// ----------------- Paths -----------------
/** Codex home directory (rollouts live under <home>/sessions). */
export function codexHome(): string {
  return opt("CODEX_HOME") || path.join(os.homedir(), ".codex");
}

// Resolved at call time (not module load) so CODEX_LMNR_STATE_DIR can relocate
// the state directory and tests can point it at a temp dir.
export function stateDir(): string {
  return opt("CODEX_LMNR_STATE_DIR") || path.join(codexHome(), "lmnr");
}
export function logFile(): string {
  return path.join(stateDir(), "lmnr_hook.log");
}
export function stateFile(): string {
  return path.join(stateDir(), "lmnr_state.json");
}
export function lockFile(): string {
  return path.join(stateDir(), "lmnr_state.lock");
}

// README documents `1`/`true` as the accepted values.
export const DEBUG = ["1", "true"].includes(opt("CODEX_LMNR_DEBUG").trim().toLowerCase());

function parseMaxChars(): number {
  const raw = opt("CODEX_LMNR_MAX_CHARS") || "20000";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 20000;
}
export const MAX_CHARS = parseMaxChars();

// Cap for a single OTLP export request (connect + response), in seconds.
export const EXPORT_TIMEOUT_S = 5.0;

export interface LaminarConfig {
  apiKey: string;
  baseUrl: string;
  userId: string | null;
}

export function getLaminarConfig(): LaminarConfig | null {
  // Env wins (override / CI); otherwise the file written by `lmnr-cli plugin add codex`.
  const fileCfg = readAgentPluginConfig();
  const apiKey =
    opt("LMNR_PROJECT_API_KEY") || opt("CODEX_LMNR_PROJECT_API_KEY") || fileCfg.projectApiKey || "";
  const baseUrl = (
    opt("LMNR_BASE_URL") ||
    opt("CODEX_LMNR_BASE_URL") ||
    fileCfg.baseUrl ||
    "https://api.lmnr.ai"
  ).replace(/\/+$/, "");
  // Explicit config wins; otherwise fall back to the logged-in CLI identity.
  // Do not read the Codex/OpenAI account for attribution.
  const userId = opt("LMNR_USER_ID") || readLoggedInUserId() || null;

  if (!apiKey) {
    return null;
  }
  return { apiKey, baseUrl, userId };
}
