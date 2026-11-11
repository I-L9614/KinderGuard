import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Packaged desktop app: configuration lives in the per-user data folder
// (KINDERGUARD_CONFIG_DIR, set by electron/main.js to the OS user-data path),
// so it survives app updates and never sits inside the install directory.
// Dev runs from the repo keep using the local .env in the working directory.
const externalEnv = process.env.KINDERGUARD_CONFIG_DIR ? path.join(process.env.KINDERGUARD_CONFIG_DIR, '.env') : null;
const envPath = externalEnv && fs.existsSync(externalEnv) ? externalEnv : '.env';
dotenv.config({ path: envPath });

const env = process.env;

// S3 is intentionally NOT required at startup: document storage is not active
// yet, and a missing bucket must not block every other feature. s3Service
// throws a clear error if a file operation is attempted without it.
const missingVars = ['JWT_SECRET'].filter((name) => !env[name]);
if (!env.MONGO_URI) missingVars.unshift('MONGO_URI');
if (missingVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
}

if (!env.JWT_EXPIRES_IN) {
  env.JWT_EXPIRES_IN = '1h';
}

if (!env.REFRESH_TOKEN_TTL_MS) {
  env.REFRESH_TOKEN_TTL_MS = String(30 * 24 * 60 * 60 * 1000);
}

if (!env.REFRESH_TOKEN_LIMIT) {
  env.REFRESH_TOKEN_LIMIT = '5';
}

if (!env.CORS_ORIGIN) {
  env.CORS_ORIGIN = 'http://localhost:3000';
}

export const config = {
  port: Number(env.PORT) || 4000,
  nodeEnv: env.NODE_ENV || 'development',
  corsOrigin: env.CORS_ORIGIN,
  isProduction: env.NODE_ENV === 'production',
};

export default config;
