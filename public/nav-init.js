/**
 * nav-init.js
 * Fetches nav.html, injects it, then shows/hides links based on the
 * authenticated user's role stored in localStorage.
 *
 * data-nav-role values on nav links:
 *   "admin"    – visible only to admins
 *   "customer" – visible only to customers
 *   "guest"    – visible only when NOT logged in
 *   "auth"     – visible to any authenticated user
 *   (none)     – always visible
 */
(function () {
  if (document.querySelector('meta[name="nav-inserted"]')) return;

  async function initNav() {
    /* ── Fetch and insert the nav fragment ── */
    let nav;
    try {
      const res = await fetch('/nav.html');
      if (!res.ok) return;
      const html = await res.text();
      const tmpl = document.createElement('template');
      tmpl.innerHTML = html.trim();
      nav = tmpl.content.firstElementChild;
      if (!nav) return;
      document.body.prepend(nav);
      document.body.classList.add('with-nav');
      const m   = document.createElement('meta');
      m.name    = 'nav-inserted';
      document.head.appendChild(m);
    } catch (err) {
      console.warn('Nav load failed:', err);
      return;
    }

    /* ── Determine role ── */
    const token     = localStorage.getItem('authToken');
    const cachedRole = localStorage.getItem('userRole') || '';

    /* Async verify token; fall back to cached role for instant paint */
    let role = token ? cachedRole : 'guest';
    applyRole(nav, role, null);

    if (token) {
      try {
        const r = await fetch('/api/auth/me', {
          headers: { Authorization: 'Bearer ' + token }
        });
        if (r.ok) {
          const user = await r.json();
          role = user.role || 'customer';
          localStorage.setItem('userRole', role);
          applyRole(nav, role, user);
        } else {
          /* Token invalid — treat as guest */
          localStorage.removeItem('authToken');
          localStorage.removeItem('userRole');
          applyRole(nav, 'guest', null);
        }
      } catch (e) {
        console.warn('Nav role check failed:', e);
      }
    }
  }

  function applyRole(nav, role, user) {
    const isAuth  = role !== 'guest' && role !== '';
    const isAdmin = role === 'admin';
    const isCust  = role === 'customer';

    nav.querySelectorAll('[data-nav-role]').forEach(el => {
      const r = el.dataset.navRole;
      const show =
        r === 'admin'    ? isAdmin :
        r === 'customer' ? isCust  :
        r === 'guest'    ? !isAuth :
        r === 'auth'     ? isAuth  :
        true;
      el.style.display = show ? '' : 'none';
    });

    /* User badge */
    const badge = nav.querySelector('#nav-user-badge');
    if (badge && user) {
      const label = user.deviceId ? `Device ${user.deviceId}` : (user.name || user.role || 'User');
      badge.textContent = label;
    }

    /* Logout wiring */
    const logoutBtn = nav.querySelector('#nav-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', e => {
        e.preventDefault();
        localStorage.removeItem('authToken');
        localStorage.removeItem('userRole');
        localStorage.removeItem('deviceId');
        window.location.href = '/login.html';
      });
    }

    /* Mark current page active */
    const current = window.location.pathname.replace(/\/$/, '') || '/index.html';
    nav.querySelectorAll('a.site-link').forEach(a => {
      try {
        const href = new URL(a.href, window.location.origin).pathname;
        a.classList.toggle('active', href === current || (current === '/' && href === '/index.html'));
      } catch (e) { /* ignore invalid hrefs */ }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
}());
