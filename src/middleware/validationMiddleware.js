import { validationResult } from 'express-validator';

export const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const labels = {
      email: 'כתובת דוא״ל', password: 'סיסמה', name: 'שם', branchId: 'סניף',
      licenseTypeId: 'סוג אישור', issueDate: 'תאריך התחלה', expiryDate: 'תאריך פקיעה',
      accessibleBranches: 'סניפים', status: 'מצב', id: 'מזהה', fileName: 'שם קובץ',
    };
    const fieldErrors = errors.array().map((error) => {
      const field = error.path || error.param;
      const label = labels[field] || 'פרט בטופס';
      const message = String(error.msg).toLowerCase().includes('email')
        ? 'הזינו כתובת דוא״ל תקינה.'
        : String(error.msg).toLowerCase().includes('min')
          ? `${label} קצר מדי.`
          : 'בדקו את הערך שהוזן.';
      return { field, label, message };
    });
    const labelsText = [...new Set(fieldErrors.map((error) => error.label))].join(', ');
    return res.status(400).json({ message: `חלק מהפרטים אינם תקינים: ${labelsText}.`, errors: fieldErrors });
  }
  next();
};
