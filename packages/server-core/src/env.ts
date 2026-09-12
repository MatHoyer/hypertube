import * as dotenv from "dotenv";
import fs from "node:fs";
import z from "zod";

dotenv.config({ path: "../../.env" });

const resolveSecretFromFile = (
  value: string | undefined,
  filePath: string | undefined
): string | undefined => {
  if (value?.trim()) return value.trim();
  if (!filePath) return undefined;
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
};

const envSchema = z.object({
  POSTGRES_HOST: z.string(),
  POSTGRES_USER: z.string(),
  POSTGRES_PASSWORD: z.string(),
  POSTGRES_DB: z.string(),
  POSTGRES_PORT: z.coerce.number(),
  DATABASE_URL: z.string(),
  SERVER_URL: z.url(),
  SERVER_PORT: z.coerce.number(),
  CLIENT_URL: z.url(),
  CLIENT_PORT: z.coerce.number(),
  MAIL_FROM: z.string(),
  MAIL_SMTP_HOST: z.string(),
  MAIL_SMTP_PORT: z.coerce.number(),
  MAIL_SMTP_SECURE: z.coerce.boolean().optional().default(false),
  MAIL_SMTP_USER: z.string().optional(),
  MAIL_SMTP_PASSWORD: z.string().optional(),
  BETTER_AUTH_SECRET: z.string(),
  BETTER_AUTH_URL: z.url(),
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  GITHUB_CLIENT_ID: z.string(),
  GITHUB_CLIENT_SECRET: z.string(),
  DISCORD_CLIENT_ID: z.string(),
  DISCORD_CLIENT_SECRET: z.string(),
  SCHOOL_42_CLIENT_ID: z.string(),
  SCHOOL_42_CLIENT_SECRET: z.string(),
  TRANSMISSION_HOST: z.string(),
  TRANSMISSION_RCP_PORT: z.coerce.number(),
  TRANSMISSION_TORRENT_PORT: z.coerce.number(),
  S3_ENDPOINT: z.string(),
  S3_PORT: z.coerce.number().optional(),
  S3_URL: z.url(),
  S3_USE_SSL: z.coerce.boolean().optional().default(false),
  S3_ROOT_USER: z.string(),
  S3_ROOT_PASSWORD: z.string(),
  TMDB_TOKEN: z.string(),
  PROWLARR_URL: z.url(),
  PROWLARR_API_KEY: z.string().min(1),
  PROWLARR_API_KEY_FILE: z.string().optional(),
  PROWLARR_PORT: z.coerce.number(),
  PROWLARR_INDEXER_IDS: z.string().optional().default(""),
  SUBTITLE_PROXY_URL: z.url(),
  SUBTITLE_PROXY_PORT: z.coerce.number(),
  REDIS_HOST: z.string(),
  REDIS_PORT: z.coerce.number(),
  VPN_IS_ACTIVE: z.coerce.boolean().default(false),
  NODE_ENV: z.enum(["DEV", "PROD"]).default("DEV"),
  SERVE_FRONT: z.coerce.boolean().optional().default(false),
  RUN_SCHEDULER: z.coerce.boolean().optional().default(false),
  CACHE_DRIVER: z.enum(["redis", "memory"]).optional().default("redis"),
});

const rawEnv = { ...process.env };
const prowlarrApiKey = resolveSecretFromFile(
  rawEnv.PROWLARR_API_KEY,
  rawEnv.PROWLARR_API_KEY_FILE
);
if (prowlarrApiKey) {
  rawEnv.PROWLARR_API_KEY = prowlarrApiKey;
}

export const env = envSchema.parse(rawEnv);
