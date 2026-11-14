/* ============================================================
 * Orion 主题控制 —— 暗色模式 + 配色方案
 *
 * 机制与 orion-key 一致：
 *   <html class="dark">          暗色
 *   <html data-color="orange">   配色（缺省 = coral）
 *
 * 状态持久化在 localStorage：
 *   kc.theme  = 'light' | 'dark' | 'system'
 *   kc.color  = 'coral' | 'orange' | 'emerald' | 'blue' | 'pink' | 'purple'
 *
 * 本脚本只负责视觉层，不触碰任何业务逻辑。
 * ============================================================ */
(function () {
    'use strict';

    var THEME_KEY = 'kc.theme';
    var COLOR_KEY = 'kc.color';

    var SCHEMES = [
        { key: 'coral', label: '珊瑚红', color: '#ee522b' },
        { key: 'orange', label: '暖橙', color: '#e8792b' },
        { key: 'emerald', label: '翡翠绿', color: '#14a37f' },
        { key: 'blue', label: '电光蓝', color: '#2563eb' },
        { key: 'pink', label: '桃红', color: '#e0447f' },
        { key: 'purple', label: '紫罗兰', color: '#7c3aed' }
    ];

    function read(key, fallback) {
        try {
            var v = window.localStorage.getItem(key);
            return v == null ? fallback : v;
        } catch (_) {
            return fallback;
        }
    }

    function write(key, value) {
        try {
            window.localStorage.setItem(key, value);
        } catch (_) { /* 隐私模式忽略 */ }
    }

    function prefersDark() {
        try {
            return window.matchMedia('(prefers-color-scheme: dark)').matches;
        } catch (_) {
            return false;
        }
    }

    function resolveTheme() {
        var stored = read(THEME_KEY, 'system');
        if (stored === 'dark' || stored === 'light') return stored;
        return prefersDark() ? 'dark' : 'light';
    }

    function applyTheme() {
        var root = document.documentElement;
        var dark = resolveTheme() === 'dark';
        root.classList.toggle('dark', dark);
        root.style.colorScheme = dark ? 'dark' : 'light';
        // 同步 meta theme-color（移动端地址栏）
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) {
            meta.setAttribute('content', dark ? '#0c0908' : '#faf9f7');
        }
    }

    function applyColor() {
        var root = document.documentElement;
        var color = read(COLOR_KEY, 'coral');
        if (color && color !== 'coral') {
            root.setAttribute('data-color', color);
        } else {
            root.removeAttribute('data-color');
        }
    }

    function setTheme(mode) {
        write(THEME_KEY, mode);
        applyTheme();
        syncButtons();
    }

    function setColor(color) {
        write(COLOR_KEY, color);
        applyColor();
        syncButtons();
    }

    function toggleTheme() {
        setTheme(resolveTheme() === 'dark' ? 'light' : 'dark');
    }

    /* ---------------- UI 注入 ---------------- */

    function buildControls() {
        var wrap = document.createElement('div');
        wrap.className = 'theme-toggle-wrap';
        wrap.setAttribute('role', 'group');
        wrap.setAttribute('aria-label', '外观设置');

        // 配色圆点
        var dots = document.createElement('div');
        dots.className = 'scheme-dots';
        SCHEMES.forEach(function (scheme) {
            var dot = document.createElement('button');
            dot.type = 'button';
            dot.className = 'scheme-dot';
            dot.setAttribute('data-scheme', scheme.key);
            dot.setAttribute('title', scheme.label);
            dot.setAttribute('aria-label', '配色：' + scheme.label);
            dot.style.backgroundColor = scheme.color;
            dot.addEventListener('click', function () {
                setColor(scheme.key);
            });
            dots.appendChild(dot);
        });

        // 明暗切换
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'theme-toggle';
        btn.setAttribute('data-theme-toggle', '');
        btn.setAttribute('aria-label', '切换明暗主题');
        btn.setAttribute('title', '切换明暗主题');
        btn.innerHTML =
            '<svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>' +
            '<svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<circle cx="12" cy="12" r="4"></circle>' +
            '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>';
        btn.addEventListener('click', toggleTheme);

        wrap.appendChild(dots);
        wrap.appendChild(btn);
        return wrap;
    }

    function syncButtons() {
        var color = read(COLOR_KEY, 'coral');
        var dots = document.querySelectorAll('.scheme-dot');
        for (var i = 0; i < dots.length; i += 1) {
            dots[i].classList.toggle('is-active', dots[i].getAttribute('data-scheme') === color);
        }
    }

    function mount() {
        // 前台：挂到导航右侧
        var nav = document.querySelector('.nav-links');
        if (nav && !nav.querySelector('.theme-toggle-wrap')) {
            nav.appendChild(buildControls());
        }
        // 后台：挂到侧边栏底部
        var footer = document.querySelector('.sidebar-footer');
        if (footer && !footer.querySelector('.theme-toggle-wrap')) {
            var adminControls = buildControls();
            adminControls.classList.add('theme-toggle-wrap--admin');
            footer.appendChild(adminControls);
        }
        syncButtons();
    }

    /* ---------------- 自动跟随系统 ---------------- */

    function watchSystem() {
        try {
            var mq = window.matchMedia('(prefers-color-scheme: dark)');
            var handler = function () {
                if (read(THEME_KEY, 'system') === 'system') applyTheme();
            };
            if (mq.addEventListener) mq.addEventListener('change', handler);
            else if (mq.addListener) mq.addListener(handler);
        } catch (_) { /* 忽略 */ }
    }

    // 立即应用，避免闪烁
    applyTheme();
    applyColor();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            mount();
            watchSystem();
        });
    } else {
        mount();
        watchSystem();
    }

    window.KCTheme = {
        setTheme: setTheme,
        setColor: setColor,
        toggleTheme: toggleTheme,
        schemes: SCHEMES,
        current: function () {
            return { theme: resolveTheme(), color: read(COLOR_KEY, 'coral') };
        }
    };
})();
