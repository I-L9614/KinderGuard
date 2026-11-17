// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderLicenseCard, installApprovalMenus } from '../frontend/licenseCards.js';
const license = { _id: 'l1', fileName: 'אישור.pdf', fileUrl: 'private/key', issueDate: '2026-05-11', expiryDate: '2027-05-11' };
const options = { name: 'כיבוי אש שנתי', statusClass: 'good', statusText: 'בתוקף', date: (v) => v };
const render = (row = license, opts = options) => { document.body.innerHTML = renderLicenseCard(row, opts); return document.querySelector('article'); };
describe('approval card', () => {
  it('keeps the document action separate from the filename and secondary actions', () => {
    const card = render();
    expect(card.querySelector('[data-open-file]').textContent).toBe('פתיחת מסמך');
    expect(card.querySelector('.approval-filename').textContent).toBe(license.fileName);
    expect(card.querySelector('.approval-filename').title).toBe(license.fileName);
    expect(card.querySelector('.approval-menu [data-history]').dataset.history).toBe('l1');
    expect(card.querySelector('.approval-menu [data-delete-license-file]').dataset.fileName).toBe(license.fileName);
    expect(card.querySelector('details').open).toBe(false);
    expect(card.querySelector('summary').getAttribute('aria-label')).toContain(options.name);
    expect(card.querySelectorAll('.approval-dates bdi')).toHaveLength(2);
  });
  it('shows history but no file actions for fileless approvals', () => {
    const card = render({ ...license, fileUrl: null });
    expect(card.textContent).toContain('ללא קובץ מצורף');
    expect(card.querySelector('[data-history]')).not.toBeNull();
    expect(card.querySelector('[data-open-file]')).toBeNull();
    expect(card.querySelector('[data-delete-license-file]')).toBeNull();
  });
  it('escapes untrusted names and filenames without changing the original text', () => {
    const bad = '<img src=x onerror=alert(1)>"';
    const card = render({ ...license, fileName: bad }, { ...options, name: bad });
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('.approval-name').textContent).toBe(bad);
    expect(card.querySelector('[data-delete-license-file]').dataset.fileName).toBe(bad);
  });
  it('renders warning and expired states with their text', () => {
    for (const [cls, label] of [['warning', 'לקראת פקיעה'], ['danger', 'פג תוקף']]) {
      const card = render(license, { ...options, statusClass: cls, statusText: label });
      expect(card.querySelector('.status-pill').classList.contains(cls)).toBe(true);
      expect(card.querySelector('.status-pill').textContent).toBe(label);
    }
  });
  it('closes menus after actions, outside clicks and Escape, restoring keyboard focus', () => {
    const card = render(); installApprovalMenus(document);
    const menu = card.querySelector('details'); const summary = menu.querySelector('summary');
    menu.open = true; menu.querySelector('[data-history]').click(); expect(menu.open).toBe(false);
    menu.open = true; document.body.click(); expect(menu.open).toBe(false);
    menu.open = true; summary.focus(); summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.open).toBe(false); expect(document.activeElement).toBe(summary);
  });
});
