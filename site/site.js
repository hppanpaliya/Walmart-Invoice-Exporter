// FAQ page niceties: chrome:// settings links can't be clicked directly, so
// clicking one copies it for pasting into a new tab.
document.querySelectorAll('.copy-link').forEach((el) => {
  el.addEventListener('click', () => {
    const link = el.dataset.link || el.textContent.trim();
    navigator.clipboard.writeText(link).then(() => {
      const original = el.textContent;
      el.textContent = 'Copied!';
      setTimeout(() => { el.textContent = original; }, 1200);
    });
  });
});
