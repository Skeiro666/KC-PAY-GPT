/* ============================================================
 * 后台外壳交互（纯增量）
 *
 * 只负责小屏导航抽屉，不触碰业务脚本：
 * - 生成移动端顶栏按钮与遮罩
 * - 打开/关闭抽屉，同步 aria-expanded
 * - 点击任一导航项、遮罩或按 Esc 关闭
 * - 窗口变宽回桌面尺寸时自动复位
 * ============================================================ */
(function () {
    'use strict';

    var BREAKPOINT = 1024;
    var body = document.body;
    var sidebar = document.querySelector('.sidebar');
    var main = document.querySelector('.main-content');

    if (!sidebar || !main) {
        return;
    }

    var bar = document.createElement('div');
    bar.className = 'admin-mobile-bar';

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'admin-nav-toggle';
    toggle.setAttribute('aria-label', '打开导航菜单');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'admin-sidebar');
    toggle.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>';

    var brand = document.createElement('span');
    brand.className = 'admin-mobile-brand';
    brand.textContent = 'KC GPT自动充值系统';

    bar.appendChild(toggle);
    bar.appendChild(brand);
    main.insertBefore(bar, main.firstChild);

    if (!sidebar.id) {
        sidebar.id = 'admin-sidebar';
    }

    var scrim = document.createElement('div');
    scrim.className = 'nav-scrim';
    scrim.setAttribute('aria-hidden', 'true');
    body.appendChild(scrim);

    // 抽屉内的关闭按钮（仅小屏显示）
    var brandRow = sidebar.querySelector('.sidebar-brand');
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'admin-nav-close';
    closeBtn.setAttribute('aria-label', '关闭导航菜单');
    closeBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';
    if (brandRow) {
        brandRow.appendChild(closeBtn);
    }

    function isOpen() {
        return body.classList.contains('nav-open');
    }

    function setOpen(open) {
        body.classList.toggle('nav-open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
        if (open) {
            var active = sidebar.querySelector('.nav-item.active');
            if (active && typeof active.focus === 'function') {
                active.focus({ preventScroll: true });
            }
        } else {
            toggle.focus({ preventScroll: true });
        }
    }

    toggle.addEventListener('click', function () {
        setOpen(!isOpen());
    });

    scrim.addEventListener('click', function () {
        setOpen(false);
    });

    closeBtn.addEventListener('click', function () {
        setOpen(false);
    });

    // 点击任意导航项后收起抽屉（不拦截原有 inline onclick）
    sidebar.addEventListener('click', function (event) {
        var item = event.target.closest ? event.target.closest('.nav-item') : null;
        if (item) {
            setOpen(false);
        }
    });

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && isOpen()) {
            setOpen(false);
        }
    });

    window.addEventListener('resize', function () {
        if (window.innerWidth > BREAKPOINT && isOpen()) {
            body.classList.remove('nav-open');
            toggle.setAttribute('aria-expanded', 'false');
        }
    });
})();
