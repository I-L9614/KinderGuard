import logger from '../utils/logger.js';

const safeStatus = (err, res) => {
  if (err.type === 'entity.parse.failed') return 400;
  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') return 413;
  if (err.name === 'MulterError') return 400;
  if (err.name === 'ValidationError' || err.name === 'CastError') return 400;
  if (err.code === 11000) return 409;
  if (err.name === 'MongoServerSelectionError' || err.name === 'MongoNetworkError') return 503;
  return err.statusCode || err.status || (res.statusCode !== 200 ? res.statusCode : 500);
};

const publicMessage = (err, statusCode) => {
  if (err.publicMessage) return err.publicMessage;
  if (err.type === 'entity.parse.failed') return 'הנתונים שנשלחו אינם תקינים. בדקו את הטופס ונסו שוב.';
  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') return 'הקובץ גדול מדי. אפשר להעלות קבצים עד 15MB.';
  if (err.name === 'MulterError' && err.code === 'LIMIT_UNEXPECTED_FILE') return 'נבחר שדה קובץ לא צפוי. בדקו את הטופס ונסו שוב.';
  if (err.name === 'MulterError') return 'לא ניתן לקבל את הקובץ שנבחר. בדקו את סוג הקובץ והגודל ונסו שוב.';
  if (err.name === 'ValidationError' || err.name === 'CastError') return 'חלק מהפרטים אינם תקינים. בדקו אותם ונסו שוב.';
  if (err.code === 11000) return 'רשומה עם הפרטים האלה כבר קיימת.';
  if (err.name === 'MongoServerSelectionError' || err.name === 'MongoNetworkError') return 'לא ניתן להתחבר למסד הנתונים כרגע. בדקו את חיבור האינטרנט ונסו שוב.';

  const messages = {
    400: 'הבקשה אינה תקינה. בדקו את הפרטים ונסו שוב.',
    401: 'החיבור פג או שאינו תקף. התחברו שוב.',
    403: 'אין לכם הרשאה לבצע את הפעולה הזו.',
    404: 'הפריט המבוקש לא נמצא.',
    409: 'לא ניתן לשמור את השינוי כי קיימת רשומה דומה.',
    413: 'הקובץ גדול מדי. אפשר להעלות קבצים עד 15MB.',
    429: 'נשלחו יותר מדי בקשות. המתינו מעט ונסו שוב.',
    502: 'שירות האחסון אינו זמין כרגע. נסו שוב בעוד רגע.',
    503: 'השירות אינו זמין כרגע. בדקו את החיבור ונסו שוב.',
  };

  if (statusCode < 500 && /[\u0590-\u05FF]/.test(err.message || '')) return err.message;
  return messages[statusCode] || 'אירעה שגיאה בלתי צפויה. נסו שוב, ואם היא חוזרת פנו למנהל המערכת.';
};

const redact = (value) => String(value || '')
  .replace(/mongodb(?:\+srv)?:\/\/[^\s'"`]+/gi, '[MongoDB URI redacted]')
  .replace(/(password|passwd|token|secret|api[_-]?key)=([^\s&]+)/gi, '$1=[redacted]');

export const notFound = (req, res, next) => {
  const error = new Error('Not Found');
  error.statusCode = 404;
  next(error);
};

export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const statusCode = safeStatus(err, res);
  const internalMessage = redact(err.stack || err.message);
  if (statusCode >= 500) logger.error(`${req.method} ${req.path} (${err.name || 'Error'}): ${internalMessage}`);
  res.status(statusCode).json({ message: publicMessage(err, statusCode) });
};
