// Loaded synchronously in <head> (CSP forbids inline scripts) to apply the
// saved theme before first paint. Keep it tiny and dependency-free.
try {
  const saved = localStorage.getItem('tracker-theme');
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.dataset['theme'] = saved;
  }
} catch {
  // Storage unavailable: follow the system theme.
}
