// Long lists show only the first few items, with a button for the rest.
// Small rows get a higher limit than big cards. Search and filters decide
// which items match first; hidden items are still searched, and while a
// search is active every match is shown.
export const LIST_LIMITS = { card: 7, row: 10 };
const expanded = new Set();

// Pure: how many matching items to show.
export function visibleCount(total, limit, isExpanded, searching) {
  if (searching || isExpanded || total <= limit) return total;
  return limit;
}

export const resetCollapsed = () => expanded.clear();

export function collapseLabel(hidden, isExpanded) {
  return isExpanded ? 'הצג פחות' : `הצג הכול (עוד ${hidden})`;
}

// container: element holding the items. A "matching" item is one that search or
// filters have not hidden with style.display = 'none'.
export function collapseList(container, { itemSelector, limit = LIST_LIMITS.row, key, searching = false }) {
  if (!container) return;
  const items = [...container.querySelectorAll(itemSelector)];
  const matching = items.filter((el) => el.style.display !== 'none');
  const isExpanded = expanded.has(key);
  const show = visibleCount(matching.length, limit, isExpanded, searching);
  matching.forEach((el, i) => el.classList.toggle('list-collapsed', i >= show));
  items.filter((el) => el.style.display === 'none').forEach((el) => el.classList.remove('list-collapsed'));
  let button = container.parentNode.querySelector(`[data-collapse-for="${key}"]`);
  const needButton = !searching && matching.length > limit;
  if (!needButton) { button?.remove(); return; }
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary small-btn full list-more';
    button.dataset.collapseFor = key;
    button.onclick = () => {
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      collapseList(container, { itemSelector, limit, key, searching: false });
    };
    container.after(button);
  }
  button.textContent = collapseLabel(matching.length - limit, isExpanded);
  button.setAttribute('aria-expanded', String(isExpanded));
}
