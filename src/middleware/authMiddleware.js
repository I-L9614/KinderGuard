import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ message: 'נדרשת התחברות כדי לבצע את הפעולה.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ message: 'החיבור פג או שאינו תקף. התחברו שוב.' });
  }

  req.user = await User.findById(decoded.id).select('-password');
  if (!req.user) return res.status(401).json({ message: 'המשתמש אינו קיים עוד. התחברו מחדש.' });
  // Access JWTs outlive a password change by up to their expiry. The token
  // carries the auth version it was issued under; a password reset increments
  // the version atomically with the password write, so a stale version means
  // the password changed after this token was minted - reject it, even if it
  // was minted in the very same second as the change.
  if ((decoded.av || 0) !== (req.user.authVersion || 0)) {
    return res.status(401).json({ message: 'החיבור פג או שאינו תקף. התחברו שוב.' });
  }
  return next();
};

export const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403);
      const error = new Error('Access denied');
      error.statusCode = 403;
      error.publicMessage = 'אין לכם הרשאה לבצע את הפעולה הזו.';
      throw error;
    }
    next();
  };
};
