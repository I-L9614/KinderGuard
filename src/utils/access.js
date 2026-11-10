export const getAdminId = (user) => user.adminId || user._id;

export const hasBranchAccess = (user, branch) => {
  if (!branch || String(branch.adminId) !== String(getAdminId(user))) return false;
  return user.role === 'Admin' || user.accessibleBranches.some((id) => String(id) === String(branch._id));
};

