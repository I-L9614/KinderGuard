import './config/env.js';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import branchRoutes from './routes/branchRoutes.js';
import userRoutes from './routes/userRoutes.js';
import licenseRoutes from './routes/licenseRoutes.js';
import licenseTypeRoutes from './routes/licenseTypeRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import taskRoutes from './routes/taskRoutes.js';
import rentRoutes from './routes/rentRoutes.js';
import importRoutes from './routes/importRoutes.js';
import { errorHandler, notFound } from './middleware/errorMiddleware.js';
import { applySecurityMiddleware } from './middleware/securityMiddleware.js';
import logger from './utils/logger.js';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/authRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendPath = path.resolve(__dirname, '../frontend');

const app = express();
// Hosted deployments (Render and similar) sit behind a reverse proxy that
// sets X-Forwarded-For. express-rate-limit refuses to run when that header
// arrives without trust proxy configured, so hosted deploys set TRUST_PROXY=1.
// Desktop runs bind loopback directly and keep the default (no trust).
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
applySecurityMiddleware(app);

const allowedOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin === '*' ? true : allowedOrigin, credentials: true, optionsSuccessStatus: 200 }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
}

app.disable('x-powered-by');

// simple request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

app.use(cookieParser());

app.use('/api/branches', branchRoutes);
app.use('/api/users', userRoutes);
app.use('/api/licenses', licenseRoutes);
app.use('/api/license-types', licenseTypeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/rent', rentRoutes);
app.use('/api/import', importRoutes);
app.use('/api/auth', authRoutes);

if (fs.existsSync(frontendPath)) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/health')) {
      return next();
    }
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

app.use(notFound);
app.use(errorHandler);

export default app;
