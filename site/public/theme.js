// Applies the saved theme before the page paints. Carbon (dark) is the default; chalk follows the system or the choice.
try {
  const saved = localStorage.getItem('breakaway.theme');
  if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;
} catch {
  // Storage can be blocked; the system setting decides then.
}
