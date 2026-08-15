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
        .then(html => { try { sessionStorage.setItem(NAV_CACHE_KEY, html); } catch (e) { console.warn('[Nav] sessionStorage write failed:', e); } return html; });

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
    /* org admins share the admin nav (Dashboard / Analytics / Analysis
       Board) — every one of those pages is org-scoped on the backend, so
       they see only their own tenant's data. */
    const isAdmin    = role === 'admin' || role === 'org_admin';
    const isEngineer = role === 'engineer';
    const isCust     = role === 'customer';

    nav.querySelectorAll('[data-nav-role]').forEach(el => {
      const r = el.dataset.navRole;
      const show =
        r === 'admin'    ? isAdmin :
        r === 'engineer' ? isEngineer :
        r === 'customer' ? isCust  :
        r === 'guest'    ? !isAuth :
        r === 'auth'     ? isAuth  :
        true;
      el.style.display = show ? '' : 'none';
    });

    const badge = nav.querySelector('#nav-user-badge');
    if (badge && user) {
      /* Org admins get their organization's name in the badge so it's
         always obvious which tenant they're operating in. */
      if (user.role === 'org_admin' && user.organization?.name) {
        badge.textContent = `Org: ${user.organization.name}`;
      } else {
        badge.textContent = user.deviceId ? `Device ${user.deviceId}` : (user.name || user.role || 'User');
      }
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
      } catch (e) { console.warn('[Nav] Invalid link href:', e); }
    });
  }

  /* Site-wide developer credit — appended to every page that carries the
     nav, so it doesn't need to be duplicated in each HTML file. */
  function insertCredit() {
    if (document.getElementById('site-credit')) return;
    const credit = document.createElement('div');
    credit.id = 'site-credit';
    credit.style.cssText =
      'text-align:center;padding:14px 16px 18px;font-size:11px;color:#64748b;';
    credit.textContent = 'SolGrid v2.1 · Developed by Larry Thuku';
    document.body.appendChild(credit);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { initNav(); insertCredit(); });
  } else {
    initNav();
    insertCredit();
  }
}());
