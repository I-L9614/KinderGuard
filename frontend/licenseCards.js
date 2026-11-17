const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icons = {
  document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>'
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

export function renderLicenseCard(license, { name, statusClass, statusText, date }) {
  const id = escapeHtml(license._id);
  const fileName = escapeHtml(license.fileName || '');
  return `<article class="license-row approval-card" data-license-id="${id}" data-search="${escapeHtml(name + ' ' + (license.fileName || ''))}">
    <div class="approval-heading"><span class="approval-icon ${statusClass}">${icon('document')}</span><strong class="approval-name">${escapeHtml(name)}</strong><span class="status-pill ${statusClass}">${escapeHtml(statusText)}</span></div>
    <div class="approval-dates">${icon('calendar')}<span>תוקף: <bdi>${escapeHtml(date(license.issueDate))}</bdi> - <bdi>${escapeHtml(date(license.expiryDate))}</bdi></span></div>
    <div class="approval-footer">${license.fileUrl ? `<button class="primary approval-open" data-open-file="${id}">${icon('eye')}פתיחת מסמך</button><span class="approval-filename" dir="auto" title="${fileName}">${fileName}</span>` : '<span class="approval-no-file">ללא קובץ מצורף</span>'}
      <details class="approval-menu" name="approval-actions"><summary aria-label="פעולות נוספות: ${escapeHtml(name)}" title="פעולות נוספות"><span aria-hidden="true">⋮</span></summary><div class="approval-menu-items"><button class="text-button" data-history="${id}">${icon('clock')}היסטוריה</button>${license.fileUrl ? `<button class="text-button danger-text" data-delete-license-file="${id}" data-file-name="${fileName}">${icon('trash')}מחיקת מסמך</button>` : ''}</div></details>
    </div>
  </article>`;
}

// Native details/summary supplies keyboard activation and expanded state.
// Close transient menus after an action, outside click, or Escape.
export function installApprovalMenus(doc = document) {
  doc.addEventListener('click', (event) => {
    doc.querySelectorAll('.approval-menu[open]').forEach((menu) => {
      if (!menu.contains(event.target) || event.target.closest('button')) menu.open = false;
    });
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    doc.querySelectorAll('.approval-menu[open]').forEach((menu) => {
      const focused = menu.contains(doc.activeElement);
      menu.open = false;
      if (focused) menu.querySelector('summary').focus();
    });
  });
}
