(function () {
  if (document.querySelector('meta[name="nav-inserted"]')) return;

  const NAV_CACHE_KEY = 'nav_html_v1';
  const token = localStorage.getItem('authToken');

  /* Fire both requests in parallel before any awaiting */
  const authPromise = token
    ? fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } })
        .catch(() => null)
    : Promise.resolve(null);

  const cachedHtml = sessionStorage.getItem(NAV_CACHE_KEY);
  const navPromise = cachedHtml
    ? Promise.resolve(cachedHtml)
    : fetch('/nav.html')
        .then(r => r.ok ? r.text() : Promise.reject(new Error('nav fetch failed')))
        .then(html => { try { sessionStorage.setItem(NAV_CACHE_KEY, html); } catch (_) {} return html; });

  async function initNav() {
    /* ── Insert nav from cache or network ── */
    let nav;
    try {
      const html = await navPromise;
      const tmpl = document.createElement('template');
      tmpl.innerHTML = html.trim();
      nav = tmpl.content.firstElementChild;
      if (!nav) return;
      document.body.prepend(nav);
      document.body.classList.add('with-nav');
      const m = document.createElement('meta');
      m.name  = 'nav-inserted';
      document.head.appendChild(m);
    } catch (err) {
      console.warn('Nav load failed:', err);
      return;
    }

    /* ── Instant paint with cached role ── */
    const cachedRole = localStorage.getItem('userRole') || '';
    applyRole(nav, token ? (cachedRole || 'customer') : 'guest', null);

    /* ── Resolve auth (already in flight) ── */
    if (token) {
      try {
        const r = await authPromise;
        if (r && r.ok) {
          const user = await r.json();
          const role = user.role || 'customer';
          localStorage.setItem('userRole', role);
          applyRole(nav, role, user);
        } else {
          localStorage.removeItem('authToken');
          localStorage.removeItem('userRole');
          applyRole(nav, 'guest', null);
        }
      } catch (err) {
        console.warn('Nav auth check failed:', err);
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

    const badge = nav.querySelector('#nav-user-badge');
    if (badge && user) {
      badge.textContent = user.deviceId ? `Device ${user.deviceId}` : (user.name || user.role || 'User');
    }

    const logoutBtn = nav.querySelector('#nav-logout-btn');
    if (logoutBtn && !logoutBtn._wired) {
      logoutBtn._wired = true;
      logoutBtn.addEventListener('click', e => {
        e.preventDefault();
        localStorage.removeItem('authToken');
        localStorage.removeItem('userRole');
        localStorage.removeItem('deviceId');
        window.location.href = '/login.html';
      });
    }

    const current = window.location.pathname.replace(/\/$/, '') || '/index.html';
    nav.querySelectorAll('a.site-link').forEach(a => {
      try {
        const href = new URL(a.href, window.location.origin).pathname;
        a.classList.toggle('active', href === current || (current === '/' && href === '/index.html'));
      } catch (_) {}
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
}());
