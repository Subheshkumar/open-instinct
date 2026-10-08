import { InkboxProvisioner } from "@open-instinct/inkbox";
import { consoleLogger } from "./logger.js";
import type { LinkPassthrough } from "./provision.js";
import { type GatewayServer, createGateway } from "./server.js";
import { UserStore } from "./store.js";
import type { WhatsAppGatewayConfig } from "./whatsapp.js";

export const DEFAULT_AGENT_IMAGE = "ghcr.io/mariagorskikh/open-instinct-agent:latest";

export interface GatewayEnv {
  port: number;
  publicUrl: string;
  dataDir: string;
  inkboxAdminApiKey?: string;
  inkboxBaseUrl?: string;
  maritimeApiKey: string;
  maritimeBaseUrl?: string;
  agentImage: string;
  signupSecret?: string;
  /** GATEWAY_ALLOW_OPEN_SIGNUP=1: run the signup form without an invite code. Off by default. */
  allowOpenSignup: boolean;
  /** GATEWAY_TRUST_PROXY=1: rate-limit by X-Forwarded-For (Railway, Fly, a reverse proxy you run). */
  trustProxy: boolean;
  anthropicApiKey?: string;
  composioApiKey?: string;
  composioToolkits?: string;
  idleTtlSeconds?: number;
  useMaritimeLlm: boolean;
  maritimeModel?: string;
  link?: LinkPassthrough;
  whatsapp?: WhatsAppGatewayConfig;
  agentExtraEnv?: Record<string, string>;
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) throw new Error(`${key} must be an integer from 1 to 100000`);
  return value;
}

function money(env: NodeJS.ProcessEnv, key: string, fallback: number): string {
  const value = Number(env[key] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
  return String(value);
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes)$/i.test(v.trim());
}

function bootstrapNumbers(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const numbers = value.split(",").map((number) => number.trim());
  if (numbers.some((number) => !/^\+?\d{7,15}$/.test(number))) throw new Error("WHATSAPP_BOOTSTRAP_NUMBERS must contain comma-separated phone numbers with country codes");
  return [...new Set(numbers.map((number) => number.replace(/^\+/, "")))];
}

/** The only place the gateway reads process.env. Everything else takes options. */
export function readEnv(env: NodeJS.ProcessEnv): GatewayEnv {
  const port = Number(env["PORT"] ?? 8787);
  const maritimeApiKey = env["MARITIME_API_KEY"];
  if (!maritimeApiKey) throw new Error("MARITIME_API_KEY is required (the gateway forwards every message through Maritime).");
  const publicUrl = env["GATEWAY_PUBLIC_URL"] ?? `http://localhost:${port}`;
  const idle = env["INSTINCT_IDLE_TTL_SECONDS"] ? Number(env["INSTINCT_IDLE_TTL_SECONDS"]) : undefined;
  let whatsapp: WhatsAppGatewayConfig | undefined;
  if (["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_API_VERSION"].some((key) => env[key]?.trim())) {
    const required = (key: string): string => { const value = env[key]?.trim(); if (!value) throw new Error(`${key} is required for WhatsApp`); return value; };
    const gatewayUrl = new URL(publicUrl);
    if (gatewayUrl.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(gatewayUrl.hostname)) throw new Error("WhatsApp GATEWAY_PUBLIC_URL must use HTTPS");
    whatsapp = {
      accessToken: required("WHATSAPP_ACCESS_TOKEN"), appSecret: required("WHATSAPP_APP_SECRET"), verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
      phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"), apiVersion: required("WHATSAPP_API_VERSION"),
      publicNumber: env.WHATSAPP_PUBLIC_NUMBER?.trim() || undefined,
      bootstrapNumbers: bootstrapNumbers(env.WHATSAPP_BOOTSTRAP_NUMBERS),
      messagesPerDay: positiveInteger(env, "WHATSAPP_MESSAGES_PER_DAY", 100), repliesPerDay: positiveInteger(env, "WHATSAPP_REPLIES_PER_DAY", 300),
      maxUsers: positiveInteger(env, "WHATSAPP_MAX_USERS", 100), newUsersPerHour: positiveInteger(env, "WHATSAPP_NEW_USERS_PER_HOUR", 20),
      notificationTemplate: env.WHATSAPP_NOTIFICATION_TEMPLATE?.trim() || undefined, templateLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE?.trim() || "en",
    };
    if (!env.INSTINCT_AGENT_IMAGE?.trim()) throw new Error("INSTINCT_AGENT_IMAGE must name the agent image built from this WhatsApp-enabled repository");
  }
  const linkClientId = env["LINK_CLIENT_ID"] || undefined;
  const link: LinkPassthrough | undefined = linkClientId
    ? {
        clientId: linkClientId,
        ...(env["LINK_CLIENT_SECRET"] ? { clientSecret: env["LINK_CLIENT_SECRET"] } : {}),
        ...(env["STRIPE_PUBLISHABLE_KEY"] ? { stripePublishableKey: env["STRIPE_PUBLISHABLE_KEY"] } : {}),
      }
    : undefined;
  return {
    port,
    publicUrl,
    dataDir: env["GATEWAY_DATA_DIR"] ?? "./.instinct-gateway",
    inkboxAdminApiKey: env["INKBOX_ADMIN_API_KEY"] || undefined,
    inkboxBaseUrl: env["INKBOX_BASE_URL"] || undefined,
    maritimeApiKey,
    maritimeBaseUrl: env["MARITIME_API_URL"] || undefined,
    agentImage: env["INSTINCT_AGENT_IMAGE"] || DEFAULT_AGENT_IMAGE,
    signupSecret: env["GATEWAY_SIGNUP_SECRET"] || undefined,
    allowOpenSignup: truthy(env["GATEWAY_ALLOW_OPEN_SIGNUP"]) || truthy(env["GATEWAY_OPEN_SIGNUP"]),
    trustProxy: truthy(env["GATEWAY_TRUST_PROXY"]),
    anthropicApiKey: env["ANTHROPIC_API_KEY"] || undefined,
    composioApiKey: env["COMPOSIO_API_KEY"] || undefined,
    composioToolkits: env["COMPOSIO_TOOLKITS"] || env["INSTINCT_COMPOSIO_TOOLKITS"] || undefined,
    idleTtlSeconds: idle !== undefined && Number.isFinite(idle) ? idle : undefined,
    useMaritimeLlm: truthy(env["INSTINCT_USE_MARITIME_LLM"]),
    maritimeModel: env["INSTINCT_MARITIME_MODEL"] || undefined,
    link,
    whatsapp,
    agentExtraEnv: {
      ...Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "GEMINI_API_KEY", "GROQ_API_KEY", "BRAVE_SEARCH_API_KEY"].filter((key) => env[key]?.trim()).map((key) => [key, env[key]!.trim()])),
      ...(env.INSTINCT_MODEL ? { INSTINCT_MODEL: env.INSTINCT_MODEL } : {}),
      ...(env.INSTINCT_OWNER_TIMEZONE ? { INSTINCT_OWNER_TIMEZONE: env.INSTINCT_OWNER_TIMEZONE } : {}),
      ...(whatsapp ? {
        INSTINCT_SPEND_PER_ACTION_USD: money(env, "INSTINCT_SPEND_PER_ACTION_USD", 25),
        INSTINCT_SPEND_PER_DAY_USD: money(env, "INSTINCT_SPEND_PER_DAY_USD", 50),
        INSTINCT_SPEND_ASK_ABOVE_USD: money(env, "INSTINCT_SPEND_ASK_ABOVE_USD", 0),
      } : {}),
    },
  };
}

/**
 * Signup provisions an Inkbox identity and a Maritime VM, both billed to the
 * operator. With a provisioner configured the form is live, so it must be
 * behind an invite code unless the operator opts into open signup by name.
 */
export function checkSignupPolicy(cfg: Pick<GatewayEnv, "inkboxAdminApiKey" | "signupSecret" | "allowOpenSignup">): { ok: true; open: boolean } | { ok: false; reason: string } {
  if (!cfg.inkboxAdminApiKey) return { ok: true, open: false };
  if (cfg.signupSecret) return { ok: true, open: false };
  if (cfg.allowOpenSignup) return { ok: true, open: true };
  return {
    ok: false,
    reason:
      "INKBOX_ADMIN_API_KEY is set but GATEWAY_SIGNUP_SECRET is not. Every signup creates a billed identity and VM, so set an invite code, " +
      "or set GATEWAY_ALLOW_OPEN_SIGNUP=1 to run the form open to the internet on purpose.",
  };
}

export function startGateway(cfg: GatewayEnv): GatewayServer {
  const log = consoleLogger;
  const policy = checkSignupPolicy(cfg);
  if (!policy.ok) throw new Error(policy.reason);
  if (policy.open) {
    log.warn("gateway.open_signup", {
      warning: "Signup is open to anyone. Each signup bills your Maritime wallet and Inkbox plan. Set GATEWAY_SIGNUP_SECRET to close it.",
    });
  }

  const store = new UserStore(cfg.dataDir);
  const inkbox = cfg.inkboxAdminApiKey
    ? new InkboxProvisioner({ adminApiKey: cfg.inkboxAdminApiKey, baseUrl: cfg.inkboxBaseUrl })
    : undefined;
  if (!inkbox && !cfg.whatsapp) log.warn("gateway.relay_only", { reason: "INKBOX_ADMIN_API_KEY not set; signup disabled" });
  if (!cfg.publicUrl.startsWith("https://")) log.warn("gateway.public_url_not_https", { publicUrl: cfg.publicUrl });

  const server = createGateway({
    store,
    publicUrl: cfg.publicUrl,
    inkbox,
    inkboxBaseUrl: cfg.inkboxBaseUrl,
    whatsapp: cfg.whatsapp,
    maritime: {
      apiKey: cfg.maritimeApiKey,
      baseUrl: cfg.maritimeBaseUrl,
      agentImage: cfg.agentImage,
      idleTtlSeconds: cfg.idleTtlSeconds,
      useMaritimeLlm: cfg.useMaritimeLlm,
      maritimeModel: cfg.maritimeModel,
      extraEnv: cfg.agentExtraEnv,
    },
    signupSecret: cfg.signupSecret,
    anthropicApiKey: cfg.anthropicApiKey,
    composioApiKey: cfg.composioApiKey,
    composioToolkits: cfg.composioToolkits,
    link: cfg.link,
    trustProxy: cfg.trustProxy,
    logger: log,
    // The triage endpoint called with an identity-scoped key answers for that identity, so its QR fits the user.
    routerInfoFor: (user) => new InkboxProvisioner({ adminApiKey: user.identityApiKey, baseUrl: cfg.inkboxBaseUrl }).routerInfo(),
  });
  server.listen(cfg.port, "0.0.0.0", () => {
    log.info("gateway.listening", { port: cfg.port, publicUrl: cfg.publicUrl, users: store.all().length, signup: Boolean(inkbox), link: Boolean(cfg.link) });
    server.resumePending();
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(0), 10_000);
    deadline.unref();
    server.close(() => { void server.drainWebhooks().finally(() => process.exit(0)); });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return server;
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    startGateway(readEnv(process.env));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
