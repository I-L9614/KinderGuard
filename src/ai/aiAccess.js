// Who may use the AI worker: only users with aiEnabled. The two managers get it
// through a one-time, approved enablement; new users get it only when an admin
// ticks the box while creating them. Enforced server-side on every AI route.
export const canUseAi = (user) => Boolean(user && user.aiEnabled === true);

export const requireAiAccess = (req, res, next) => {
  if (!canUseAi(req.user)) {
    return res.status(403).json({ message: 'אין לכם הרשאה להשתמש בעוזר ה-AI.' });
  }
  return next();
};
