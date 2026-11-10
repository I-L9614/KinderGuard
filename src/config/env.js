import dotenv from 'dotenv';

dotenv.config();

const env = process.env;

const missingVars = ['JWT_SECRET', 'S3_BUCKET_NAME', 'S3_REGION'].filter((name) => !env[name]);
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
