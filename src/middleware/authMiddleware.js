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
