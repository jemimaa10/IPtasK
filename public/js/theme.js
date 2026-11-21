// Light / dark theme. Loaded as a classic script in <head> so the page never flashes the wrong theme.
(function () {
  var KEY = 'iptask-theme';
  var COLORS = { dark: '#0a0b10', light: '#e6f3eb' };
  function saved() {
    try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch (e) { return 'dark'; }
  }
  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', COLORS[theme]);
  }
  apply(saved());
  window.iptaskTheme = {
    get: function () { return document.documentElement.dataset.theme || 'dark'; },
    set: function (theme) {
      apply(theme === 'light' ? 'light' : 'dark');
      try { localStorage.setItem(KEY, theme); } catch (e) { /* private mode: applies for this visit only */ }
    },
  };
  document.addEventListener('DOMContentLoaded', function () { apply(saved()); });
})();
