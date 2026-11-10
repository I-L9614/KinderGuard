import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

export const applySecurityMiddleware = (app) => {
  if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  app.use(helmet());
  app.use(compression());

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ message: 'נשלחו יותר מדי בקשות. המתינו מעט ונסו שוב.' }),
  });

  app.use(limiter);
};
