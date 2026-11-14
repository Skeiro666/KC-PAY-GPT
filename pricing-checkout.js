'use strict';

const { getRegionConfig } = require('./region-config');
const { assertChatGptLoggedIn } = require('./session-auth');
const { clearHumanVerification } = require('./human-verification');

const PRICING_URL = 'https://chatgpt.com/';

const REGION_UI_LABELS = {
    PH: ['菲律宾', 'Philippines', 'Pilipinas'],
    US: ['美国', 'United States'],
    SG: ['新加坡', 'Singapore'],
    MY: ['马来西亚', 'Malaysia']
};

const REGION_CURRENCY_HINTS = {
    PH: ['₱'],
    US: ['$20', '$ 20'],
    SG: ['S$', 'SGD'],
    MY: ['RM', 'MYR']
};

const REGION_PRICE_PATTERNS = {
    PH: [/₱\s*[\d,.]+/, /[\d,.]+\s*₱/],
    US: [/\$\s*20(?:\.00)?/, /USD\s*20/i, /\$\s*[\d,.]+(?:\s*\/)?\s*(?:month|mo)/i],
    SG: [/S\$\s*[\d,.]+/, /[\d,.]+\s*SGD/i],
    MY: [/RM\s*[\d,.]+/, /[\d,.]+\s*MYR/i]
};

const REGION_WRONG_CURRENCY = {
    PH: [/£\s*[\d,.]+/, /[\d,.]+\s*£/, /\bGBP\b/i, /United Kingdom/i, /Great Britain/i, /€\s*[\d,.]+/, /[\d,.]+\s*€/, /\bEUR\b/i],
    US: [/£\s*[\d,.]+/, /₱\s*[\d,.]+/, /\bGBP\b/i, /\bPHP\b/i, /S\$\s*[\d,.]+/, /RM\s*[\d,.]+/],
    SG: [/£\s*[\d,.]+/, /₱\s*[\d,.]+/, /\$\s*20(?:\.00)?\s*(?:USD|\/)/i, /RM\s*[\d,.]+/],
    MY: [/£\s*[\d,.]+/, /₱\s*[\d,.]+/, /S\$\s*[\d,.]+/, /\$\s*20(?:\.00)?/]
};

const REGION_CURRENT_COUNTRY_HINTS = {
    PH: [/菲律宾|Philippines|Pilipinas/i],
    US: [/United States|美国(?!地区)/i],
    SG: [/Singapore|新加坡/i],
    MY: [/Malaysia|马来西亚/i]
};

const SKIP_REGION_BUTTON_TEXT = /^(Upgrade|Personal|Business|Free|Plus|Pro|Subscribe|Close|Your current plan|升级|订阅|关闭)$/i;

const PLAN_UPGRADE_PATTERNS = {
    plus: [
        /升级至\s*Plus/i,
        /Upgrade to Plus/i,
        /Get Plus/i,
        /Subscribe to Plus/i,
        /Try Plus/i,
        /Buy now/i,
        /^Buy$/i,
        /Purchase/i,
        /^Subscribe$/i,
        /Get started/i,
        /Start now/i,
        /Start.*Plus.*trial/i,
        /Plus.*free trial/i,
        /免费.*Plus/i,
        /^Upgrade$/i
    ],
    pro_5x: [/升级至\s*Pro/i, /Upgrade to Pro/i, /Get Pro/i, /Buy now/i, /Get started/i, /Purchase/i, /^Upgrade$/i],
    pro_20x: [/升级至\s*Pro/i, /Upgrade to Pro/i, /Get Pro/i, /Buy now/i, /Get started/i, /Purchase/i, /^Upgrade$/i]
};

const PLAN_READY_PATTERN = /Buy now|Get started|Start now|Upgrade to Plus|Upgrade to Pro|Get Plus|Get Pro|Try Plus|Subscribe to Plus/i;

function matchesPlanCta(text, planType = 'plus') {
    const patterns = PLAN_UPGRADE_PATTERNS[String(planType || 'plus').toLowerCase()] || PLAN_UPGRADE_PATTERNS.plus;
    const value = String(text || '');
    return patterns.some((pattern) => pattern.test(value));
}

const GIF_PROMO_PATTERN = /Create GIFs with ChatGPT|Animate a favorite photo/i;

async function isGifPromoVisible(page) {
    return page.getByText(GIF_PROMO_PATTERN).first().isVisible({ timeout: 800 }).catch(() => false);
}

async function waitForPricingPlansReady(page, timeout = 25000) {
    const deadline = Date.now() + timeout;
    let loadingLogged = false;
    while (Date.now() < deadline) {
        if (await pageOrFramesHasText(page, PLAN_READY_PATTERN)) {
            return true;
        }
        if (!loadingLogged && await pageOrFramesHasText(page, /Loading plans/i)) {
            console.log('⏳ [步骤] 定价套餐仍在加载，等待加载完成...');
            loadingLogged = true;
        }
        await page.waitForTimeout(600);
    }
    console.warn('⚠️ [Warn] 定价套餐加载超时，将继续尝试查找升级按钮');
    return false;
}

/**
 * 关闭定价页上遮盖套餐按钮的推广弹窗（如 Create GIFs with ChatGPT）。
 */
async function dismissPricingOverlays(page) {
    if (!(await isGifPromoVisible(page))) {
        return false;
    }

    console.log('🪟 [步骤] 检测到推广弹窗，正在关闭...');
    const promoDialog = page.locator('[role="dialog"]').filter({ hasText: GIF_PROMO_PATTERN }).last();
    const closeSelectors = [
        'button[aria-label="Close" i]',
        'button[aria-label="Dismiss" i]',
        'button[aria-label="关闭"]',
        'button[title="Close" i]',
        'button[title="关闭"]'
    ];

    for (const selector of closeSelectors) {
        const closeBtn = promoDialog.locator(selector).first();
        if (await closeBtn.isVisible({ timeout: 600 }).catch(() => false)) {
            await closeBtn.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(700);
            if (!(await isGifPromoVisible(page))) {
                console.log('✅ [步骤] 推广弹窗已关闭');
                return true;
            }
        }
    }

    const clickedInDom = await promoDialog.evaluate((root) => {
        const buttons = Array.from(root.querySelectorAll('button'));
        const named = buttons.find((btn) => {
            const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''}`;
            return /close|dismiss|关闭/i.test(label);
        });
        if (named) {
            named.click();
            return true;
        }
        const iconOnly = buttons.find((btn) => !String(btn.textContent || '').trim() && btn.querySelector('svg'));
        if (iconOnly) {
            iconOnly.click();
            return true;
        }
        return false;
    }).catch(() => false);

    if (clickedInDom) {
        await page.waitForTimeout(700);
        if (!(await isGifPromoVisible(page))) {
            console.log('✅ [步骤] 推广弹窗已关闭');
            return true;
        }
    }

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
    const gone = !(await isGifPromoVisible(page));
    if (gone) {
        console.log('✅ [步骤] 推广弹窗已关闭');
    } else {
        console.warn('⚠️ [Warn] 推广弹窗仍然可见，将继续尝试点击升级按钮');
    }
    return gone;
}

function normalizeOptionText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function matchesCountryLabel(text, labels) {
    const normalized = normalizeOptionText(text).toLowerCase();
    return labels.some((label) => normalized === String(label).toLowerCase());
}

async function isBusinessTabActive(page) {
    const businessTab = page.getByRole('tab', { name: /^Business$/i }).first();
    if (await businessTab.isVisible({ timeout: 800 }).catch(() => false)) {
        const selected = await businessTab.getAttribute('aria-selected').catch(() => null);
        const state = await businessTab.getAttribute('data-state').catch(() => null);
        if (selected === 'true' || state === 'active') {
            return true;
        }
    }

    const businessCard = await page.getByText(/ChatGPT Business/i).first().isVisible({ timeout: 800 }).catch(() => false);
    const plusCard = await page.getByText(/^ChatGPT Plus$/i).first().isVisible({ timeout: 500 }).catch(() => false);
    return businessCard && !plusCard;
}

async function isPersonalPlanView(page) {
    if (await isBusinessTabActive(page)) {
        return false;
    }

    const personalTab = page.locator('[role="tab"]').filter({ hasText: /^Personal$/i }).first();
    if (await personalTab.isVisible({ timeout: 800 }).catch(() => false)) {
        const selected = await personalTab.getAttribute('aria-selected').catch(() => null);
        const state = await personalTab.getAttribute('data-state').catch(() => null);
        if (selected === 'true' || state === 'active') {
            return true;
        }
    }

    const plusCard = await page.locator('[role="dialog"]').locator('div').filter({
        hasText: /ChatGPT Plus|^Plus$/
    }).filter({
        has: page.getByRole('button', { name: /Upgrade|升级|Subscribe|Get/i })
    }).first().isVisible({ timeout: 1000 }).catch(() => false);

    if (plusCard) {
        return true;
    }

    const plusTitle = await page.getByText(/^ChatGPT Plus$/i).first().isVisible({ timeout: 800 }).catch(() => false);
    const plusBtn = await page.getByRole('button', { name: /Upgrade to Plus|升级至\s*Plus|Get Plus|Subscribe to Plus/i })
        .first()
        .isVisible({ timeout: 800 })
        .catch(() => false);
    const getStarted = await page.getByRole('button', { name: /Get started/i }).first()
        .isVisible({ timeout: 800 })
        .catch(() => false);
    const buyNow = await page.getByRole('button', { name: /Buy now|Purchase/i }).first()
        .isVisible({ timeout: 800 })
        .catch(() => false);
    const advancedCapabilities = await page.getByText(/Advanced capabilities/i).first()
        .isVisible({ timeout: 800 })
        .catch(() => false);
    const plusLabel = await page.getByText(/^Plus$/i).first().isVisible({ timeout: 500 }).catch(() => false);

    return plusTitle || plusBtn || ((getStarted || buyNow) && (advancedCapabilities || plusLabel));
}

async function isBusinessPlanView(page) {
    const businessTitle = await page.getByText(/ChatGPT Business/i).first().isVisible({ timeout: 800 }).catch(() => false);
    const onPersonal = await isPersonalPlanView(page);
    return businessTitle && !onPersonal;
}

/**
 * 定价页顶部 Personal / Business 切换（Plus/Pro 都在 Personal 下）
 */
async function switchToPersonalPlans(page) {
    if (await isPersonalPlanView(page)) {
        console.log('✅ [步骤] 已在个人套餐 (Personal) 视图');
        return;
    }

    if (await isBusinessTabActive(page)) {
        console.log('🔄 [步骤] 检测到 Business 标签，正在切换到 Personal...');
    } else {
        console.log('🔄 [步骤] 正在切换到「个人 / Personal」套餐...');
    }

    const personalCandidates = [
        () => page.getByRole('tab', { name: /^Personal$/i }).first(),
        () => page.getByRole('tab', { name: /^个人$/ }).first(),
        () => page.getByRole('button', { name: /^Personal$/i }).first(),
        () => page.getByRole('button', { name: /^个人$/ }).first(),
        () => page.getByRole('radio', { name: /^Personal$/i }).first(),
        () => page.locator('[role="tablist"] [role="tab"]').filter({ hasText: /^Personal$/i }).first(),
        () => page.locator('button').filter({ hasText: /^Personal$/ }).first(),
        () => page.locator('[role="dialog"]').getByText('Personal', { exact: true }).first(),
        () => page.getByText('Personal', { exact: true }).first()
    ];

    for (const getLocator of personalCandidates) {
        try {
            const el = getLocator();
            if (await el.isVisible({ timeout: 1200 })) {
                const selected = await el.getAttribute('aria-selected').catch(() => null);
                const pressed = await el.getAttribute('aria-pressed').catch(() => null);
                if (selected === 'true' || pressed === 'true') {
                    console.log('✅ [步骤] Personal 标签已选中');
                    return;
                }
                await el.scrollIntoViewIfNeeded().catch(() => {});
                await el.click({ timeout: 8000 });
                await page.waitForTimeout(1800);
                if (await isPersonalPlanView(page)) {
                    console.log('✅ [步骤] 已切换到个人套餐 (Personal)');
                    return;
                }
            }
        } catch (_) { /* try next */ }
    }

    if (await isBusinessPlanView(page)) {
        throw new Error('定价页停留在 Business 套餐，未能切换到 Personal，无法购买 Plus/Pro');
    }

    console.warn('[Warn] 未能确认 Personal 切换，将继续查找升级按钮');
}

async function getPricingSurface(page) {
    const dialog = page.locator('[role="dialog"]').first();
    if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
        return dialog;
    }
    return page.locator('main').first();
}

async function readPricingSurfaceText(page) {
    const surface = await getPricingSurface(page);
    return String(await surface.innerText({ timeout: 5000 }).catch(() => '') || '');
}

async function scrollPricingSurface(page) {
    const surface = await getPricingSurface(page);
    await surface.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
    }).catch(() => {});
    await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await page.waitForTimeout(600);
}

async function pageShowsTargetRegionPricing(page, regionCode) {
    const code = String(regionCode || 'PH').toUpperCase();
    const text = await readPricingSurfaceText(page);
    const positive = REGION_PRICE_PATTERNS[code] || [];
    const negative = REGION_WRONG_CURRENCY[code] || [];
    const countryHints = REGION_CURRENT_COUNTRY_HINTS[code] || [];

    const hasPositivePrice = positive.some((pattern) => pattern.test(text));
    const hasWrongCurrency = negative.some((pattern) => pattern.test(text));
    const hasCountryLabel = countryHints.some((pattern) => pattern.test(text));

    if (hasWrongCurrency) {
        return false;
    }
    if (hasPositivePrice) {
        return true;
    }
    if (hasCountryLabel && !hasWrongCurrency) {
        const looseHints = REGION_CURRENCY_HINTS[code] || [];
        if (looseHints.some((hint) => text.includes(hint))) {
            return true;
        }
    }
    return false;
}

const ALL_COUNTRY_NAME_PATTERN = /^(United Kingdom|Philippines|United States|Singapore|Malaysia|Afghanistan|Algeria|Andorra|Albania|Australia|Canada|Japan|China|菲律宾)$/i;

async function isRegionMenuOpen(page) {
    const viewport = page.locator('[data-radix-scroll-area-viewport]').last();
    if (await viewport.isVisible({ timeout: 500 }).catch(() => false)) {
        return true;
    }
    const listbox = page.locator('[role="listbox"]').first();
    if (await listbox.isVisible({ timeout: 500 }).catch(() => false)) {
        return true;
    }
    return false;
}

async function closeRegionMenuIfOpen(page) {
    if (!(await isRegionMenuOpen(page))) {
        return;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
}

async function openRegionPicker(page) {
    if (await isRegionMenuOpen(page)) {
        console.log('[Info] 地区选择器已打开');
        return true;
    }

    const surface = await getPricingSurface(page);
    await scrollPricingSurface(page);

    const triggerCandidates = [
        surface.locator('button[aria-haspopup="listbox"]').last(),
        surface.locator('button[aria-haspopup="listbox"]').first(),
        surface.locator('button[aria-haspopup="menu"]').last(),
        surface.locator('button[aria-expanded]').filter({ hasText: ALL_COUNTRY_NAME_PATTERN }).last(),
        surface.locator('[role="dialog"] button').filter({ hasText: ALL_COUNTRY_NAME_PATTERN }).last()
    ];

    for (const trigger of triggerCandidates) {
        try {
            if (!(await trigger.isVisible({ timeout: 1200 }).catch(() => false))) {
                continue;
            }
            const inListbox = await trigger.evaluate((node) => Boolean(node.closest('[role="listbox"]'))).catch(() => false);
            if (inListbox) {
                continue;
            }
            const text = normalizeOptionText(await trigger.innerText().catch(() => ''));
            if (!text || SKIP_REGION_BUTTON_TEXT.test(text)) {
                continue;
            }
            await trigger.scrollIntoViewIfNeeded().catch(() => {});
            await trigger.click({ timeout: 8000 });
            await page.waitForTimeout(900);
            if (await isRegionMenuOpen(page)) {
                console.log(`[Info] 已打开地区选择器 (${text.slice(0, 40)})`);
                return true;
            }
        } catch (_) { /* try next */ }
    }

    return false;
}

async function getCountryScrollViewport(page) {
    const viewport = page.locator('[data-radix-scroll-area-viewport]').last();
    if (await viewport.isVisible({ timeout: 1000 }).catch(() => false)) {
        return viewport;
    }

    const listbox = page.locator('[role="listbox"]').first();
    if (await listbox.isVisible({ timeout: 1000 }).catch(() => false)) {
        return listbox;
    }

    return null;
}

async function clickExactCountryInViewport(viewport, labels) {
    return viewport.evaluate((root, labelList) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const wanted = labelList.map(normalize);
        const elements = Array.from(root.querySelectorAll('[role="option"], [data-index], button, li, div'));

        for (const el of elements) {
            if (!root.contains(el)) {
                continue;
            }
            const lines = String(el.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
            if (lines.length !== 1) {
                continue;
            }
            const text = normalize(lines[0]);
            if (!wanted.includes(text)) {
                continue;
            }
            const childHasSame = Array.from(el.children).some((child) => {
                const childLines = String(child.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
                return childLines.length === 1 && normalize(childLines[0]) === text;
            });
            if (childHasSame) {
                continue;
            }
            el.scrollIntoView({ block: 'center' });
            el.click();
            return lines[0];
        }
        return '';
    }, labels).catch(() => '');
}

async function scrollVirtualCountryList(page, labels) {
    const targets = (labels || []).map((item) => String(item || '').trim()).filter(Boolean);
    if (!targets.length) {
        return false;
    }

    const viewport = await getCountryScrollViewport(page);
    if (!viewport) {
        console.warn('[Warn] 未找到可滚动的国家列表容器');
        return false;
    }

    await viewport.evaluate((node) => {
        node.scrollTop = 0;
    }).catch(() => {});
    await page.waitForTimeout(250);

    const jumpRatio = targets.some((label) => /philippines|pilipinas|菲律宾/i.test(label)) ? 0.58 : 0.5;
    await viewport.evaluate((node, ratio) => {
        node.scrollTop = Math.floor(node.scrollHeight * ratio);
    }, jumpRatio).catch(() => {});
    await page.waitForTimeout(300);

    for (let step = 0; step < 160; step += 1) {
        for (const label of targets) {
            const opt = viewport.getByText(new RegExp(`^${escapeRegExp(label)}$`, 'i')).first();
            if ((await opt.count()) > 0) {
                try {
                    await opt.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
                    if (await opt.isVisible({ timeout: 300 }).catch(() => false)) {
                        await opt.click({ timeout: 8000 });
                        console.log(`✅ [步骤] Playwright 文本匹配选中: ${label}`);
                        return true;
                    }
                } catch (_) { /* continue scrolling */ }
            }
        }

        const picked = await clickExactCountryInViewport(viewport, targets);
        if (picked) {
            console.log(`✅ [步骤] 虚拟列表第 ${step + 1} 步选中: ${picked}`);
            return true;
        }

        const visibleTexts = await viewport.evaluate((root) => {
            return Array.from(root.querySelectorAll('[role="option"], button, li'))
                .map((el) => String(el.innerText || '').split('\n')[0].trim())
                .filter(Boolean)
                .slice(0, 8);
        }).catch(() => []);
        if (step === 0 || step % 15 === 0) {
            console.log(`[Info] 滚动第 ${step + 1} 步，可见: ${visibleTexts.join(' | ') || '(empty)'}`);
        }

        const atBottom = await viewport.evaluate((node) => {
            const before = node.scrollTop;
            node.scrollTop += Math.max(72, Math.floor(node.clientHeight * 0.32));
            return node.scrollTop <= before;
        }).catch(() => true);

        await page.waitForTimeout(90);
        if (atBottom) {
            break;
        }
    }

    await viewport.hover().catch(() => {});
    for (let wheel = 0; wheel < 80; wheel += 1) {
        const picked = await clickExactCountryInViewport(viewport, targets);
        if (picked) {
            console.log(`✅ [步骤] 滚轮后选中: ${picked}`);
            return true;
        }
        await page.mouse.wheel(0, 280);
        await page.waitForTimeout(60);
    }

    return false;
}

async function scrollAndSelectCountryOption(page, labels) {
    const targets = (labels || []).map((item) => String(item || '').trim()).filter(Boolean);
    if (!targets.length) {
        return false;
    }

    if (!(await isRegionMenuOpen(page))) {
        return false;
    }

    console.log(`[Info] 开始在虚拟列表中查找: ${targets.join(' / ')}`);

    if (await scrollVirtualCountryList(page, targets)) {
        return true;
    }

    for (const label of targets) {
        if (await tryKeyboardCountryFilter(page, label)) {
            return true;
        }
    }

    return false;
}

async function clickRegionOption(page, label) {
    if (await scrollAndSelectCountryOption(page, [label])) {
        return true;
    }

    const optionLocators = [
        page.getByRole('option', { name: new RegExp(`^${escapeRegExp(label)}$`, 'i') }),
        page.getByRole('menuitem', { name: new RegExp(escapeRegExp(label), 'i') }),
        page.getByRole('radio', { name: new RegExp(escapeRegExp(label), 'i') }),
        page.getByRole('button', { name: new RegExp(`^${escapeRegExp(label)}$`, 'i') }),
        page.locator(`[role="option"]:has-text("${label}")`),
        page.locator(`[role="menuitem"]:has-text("${label}")`),
        page.locator(`li:has-text("${label}")`)
    ];

    for (const locator of optionLocators) {
        try {
            const el = locator.first();
            if ((await el.count()) === 0) {
                continue;
            }
            await el.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
            if (await el.isVisible({ timeout: 1200 })) {
                await el.click({ timeout: 8000 });
                return true;
            }
        } catch (_) { /* try next */ }
    }
    return false;
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function tryKeyboardCountryFilter(page, label) {
    const typeText = String(label || '').trim();
    if (!typeText) {
        return false;
    }

    const viewport = await getCountryScrollViewport(page);
    if (!viewport) {
        return false;
    }

    try {
        await viewport.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(150);
        await page.keyboard.press('Home').catch(() => {});
        await page.waitForTimeout(100);
        await page.keyboard.type(typeText, { delay: 60 });
        await page.waitForTimeout(500);

        const picked = await clickExactCountryInViewport(viewport, [label]);
        if (picked) {
            console.log(`✅ [步骤] 键盘筛选后已选择: ${picked}`);
            return true;
        }

        const option = page.getByRole('option', { name: new RegExp(`^${escapeRegExp(label)}$`, 'i') }).first();
        if (await option.isVisible({ timeout: 1200 }).catch(() => false)) {
            await option.click({ timeout: 8000 });
            console.log(`✅ [步骤] 键盘筛选后已选择: ${label}`);
            return true;
        }
    } catch (_) { /* ignore */ }

    return false;
}

async function readSelectedCountryLabel(page) {
    const surface = await getPricingSurface(page);
    const trigger = surface.locator('button').filter({
        hasText: /Philippines|United Kingdom|Algeria|United States|Singapore|Malaysia|Afghanistan|菲律宾/i
    }).last();
    if (await trigger.isVisible({ timeout: 1000 }).catch(() => false)) {
        return normalizeOptionText(await trigger.innerText().catch(() => ''));
    }
    return '';
}

async function selectRegionOption(page, regionCode) {
    const code = String(regionCode || 'PH').toUpperCase();
    const labels = REGION_UI_LABELS[code] || [];
    const preferredLabels = labels.filter((label) => label.length > 2);

    const search = page.locator('input[type="search"], input[placeholder*="Search" i], input[placeholder*="搜索" i]').first();
    if (await search.isVisible({ timeout: 1500 }).catch(() => false)) {
        for (const label of preferredLabels) {
            await search.fill('').catch(() => {});
            await search.fill(label).catch(() => {});
            await page.waitForTimeout(700);
            const viewport = await getCountryScrollViewport(page);
            const picked = viewport
                ? await clickExactCountryInViewport(viewport, [label])
                : '';
            if (picked) {
                console.log(`✅ [步骤] 已通过搜索框选择地区: ${picked}`);
                return verifySelectedCountry(page, preferredLabels);
            }
        }
    }

    if (await scrollAndSelectCountryOption(page, preferredLabels)) {
        return verifySelectedCountry(page, preferredLabels);
    }

    return false;
}

async function verifySelectedCountry(page, labels) {
    await page.waitForTimeout(800);
    const selected = await readSelectedCountryLabel(page);
    if (selected && matchesCountryLabel(selected, labels)) {
        console.log(`✅ [步骤] 地区选择已确认: ${selected}`);
        return true;
    }
    if (selected) {
        console.warn(`[Warn] 地区选择校验失败，当前显示: ${selected}，期望: ${labels.join(' / ')}`);
        return false;
    }
    return true;
}

/** @deprecated 使用 pageShowsTargetRegionPricing */
async function pageShowsCurrency(page, regionCode) {
    return pageShowsTargetRegionPricing(page, regionCode);
}

async function waitForPricingPage(page, timeout = 60000) {
    await page.goto(PRICING_URL, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);

    await clearHumanVerification(page, { phase: 'pricing-page', maxWaitMs: 120000 });

    await assertChatGptLoggedIn(page, '定价页');
    await dismissPricingOverlays(page);

    const url = page.url();
    if (!url.includes('chatgpt.com')) {
        throw new Error(`定价页打开失败，当前 URL: ${url}`);
    }

    if (!(await hasPricingView(page))) {
        console.log('🧭 [步骤] 未检测到定价界面，正在从首页点击 Upgrade 入口...');
        if (!(await openPricingView(page))) {
            throw new Error('未能打开套餐/定价界面：首页和侧边栏都没有可用的 Upgrade 入口');
        }
        await dismissPricingOverlays(page);
    }

    await waitForPricingPlansReady(page, 30000);
    console.log('✅ [步骤] 已打开 ChatGPT 套餐/定价界面');
}

async function hasPricingView(page) {
    const dialog = page.locator('[role="dialog"]').first();
    if (await dialog.isVisible({ timeout: 1200 }).catch(() => false)) {
        const text = String(await dialog.innerText({ timeout: 3000 }).catch(() => '') || '');
        if (/Upgrade your plan|Choose your plan|ChatGPT Plus|ChatGPT Pro|Personal|Business/i.test(text)) {
            return true;
        }
    }
    return pageOrFramesHasText(page, /Upgrade your plan|Choose your plan/i);
}

async function openPricingView(page) {
    if (await hasPricingView(page)) {
        return true;
    }

    const entryPoints = [
        page.getByRole('button', { name: /^Upgrade$/i }),
        page.getByRole('link', { name: /^Upgrade$/i }),
        page.getByRole('button', { name: /^升级$|^升级套餐$/ }),
        page.getByText(/^Upgrade$/i)
    ];

    for (const entries of entryPoints) {
        const count = await entries.count().catch(() => 0);
        for (let i = count - 1; i >= 0; i -= 1) {
            const entry = entries.nth(i);
            try {
                if (!(await entry.isVisible({ timeout: 800 }).catch(() => false))) {
                    continue;
                }
                await entry.scrollIntoViewIfNeeded().catch(() => {});
                await entry.click({ timeout: 8000 });
                await page.waitForTimeout(2500);
                if (await hasPricingView(page)) {
                    console.log('✅ [步骤] 已打开套餐/定价弹窗');
                    return true;
                }
            } catch (_) { /* try next */ }
        }
    }

    if (await openAccountMenu(page)) {
        const menuUpgradeCandidates = [
            page.getByRole('menuitem', { name: /Upgrade|升级/i }).first(),
            page.getByRole('button', { name: /Upgrade plan|升级套餐|^Upgrade$|^升级$/i }).first(),
            page.getByText(/Upgrade plan|升级套餐/i).first()
        ];
        for (const item of menuUpgradeCandidates) {
            try {
                if (!(await item.isVisible({ timeout: 1200 }).catch(() => false))) {
                    continue;
                }
                await item.click({ timeout: 8000 });
                await page.waitForTimeout(2500);
                if (await hasPricingView(page)) {
                    console.log('✅ [步骤] 已从账号菜单打开套餐/定价界面');
                    return true;
                }
            } catch (_) { /* try next */ }
        }
        if (await hasPricingView(page)) {
            return true;
        }
        const menuText = String(await page.locator('[role="menu"], [role="dialog"]').last().innerText({ timeout: 2000 }).catch(() => '') || '').replace(/\s+/g, ' ').slice(0, 200);
        if (menuText) {
            console.log(`[Info] 账号菜单内容: ${menuText}`);
        }
        await page.keyboard.press('Escape').catch(() => {});
    }

    for (const pricingUrl of ['https://chatgpt.com/#pricing', 'https://chatgpt.com/pricing']) {
        try {
            await page.goto(pricingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2500);
            if (await hasPricingView(page)) {
                console.log(`✅ [步骤] 已通过 ${pricingUrl} 打开套餐/定价界面`);
                return true;
            }
        } catch (_) { /* try next */ }
    }

    return false;
}

async function openAccountMenu(page) {
    const candidates = [
        page.locator('button').filter({ hasText: /\bFree\b|免费/ }).last(),
        page.locator('[role="button"]').filter({ hasText: /\bFree\b|免费/ }).last(),
        page.locator('nav button').last(),
        page.locator('aside button').last()
    ];

    for (const entry of candidates) {
        try {
            if (!(await entry.isVisible({ timeout: 800 }).catch(() => false))) {
                continue;
            }
            await entry.click({ timeout: 8000 });
            await page.waitForTimeout(1500);
            return true;
        } catch (_) { /* try next */ }
    }
    return false;
}

/**
 * 在定价页选择账单地区（Personal 视图下，右下角/弹窗内地区切换）
 */
async function selectPricingRegion(page, regionCode) {
    const code = String(regionCode || 'PH').toUpperCase();
    const regionConfig = getRegionConfig(code);
    console.log(`🌏 [步骤] 正在选择账单地区: ${regionConfig?.label || code}...`);
    await dismissPricingOverlays(page);

    if (await pageShowsTargetRegionPricing(page, code)) {
        console.log(`✅ [步骤] 定价页已显示目标地区价格 (${code})，跳过地区切换`);
        return;
    }

    const surfacePreview = (await readPricingSurfaceText(page)).replace(/\s+/g, ' ').slice(0, 120);
    console.log(`[Info] 当前定价页片段: ${surfacePreview}`);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (await pageShowsTargetRegionPricing(page, code)) {
            console.log(`✅ [步骤] 定价页已显示目标地区价格 (${code})`);
            return;
        }

        if (attempt > 1) {
            console.log(`[Warn] 地区切换重试 ${attempt}/3...`);
            await closeRegionMenuIfOpen(page);
            await scrollPricingSurface(page);
        }

        let menuOpen = await isRegionMenuOpen(page);
        if (!menuOpen) {
            menuOpen = await openRegionPicker(page);
        }

        if (menuOpen || await isRegionMenuOpen(page)) {
            const selected = await selectRegionOption(page, code);
            if (!selected) {
                console.warn(`[Warn] 地区菜单已打开，但未找到 ${code} 对应选项（将尝试滚动列表）`);
            } else {
                await page.waitForTimeout(2500);
            }
        } else {
            console.warn('[Warn] 未能打开地区选择器，尝试直接滚动/点击目标地区');
            await selectRegionOption(page, code);
            await page.waitForTimeout(1500);
        }

        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);

        if (await pageShowsTargetRegionPricing(page, code)) {
            console.log(`✅ [步骤] 已切换到目标地区: ${regionConfig?.label || code}`);
            return;
        }
    }

    const finalText = (await readPricingSurfaceText(page)).replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`无法将定价页切换到目标地区 ${code}（${regionConfig?.label || code}），请检查后台支付地区设置。当前页面: ${finalText}`);
}

/**
 * 点击对应套餐的升级按钮
 */
async function clickPlanUpgrade(page, planType) {
    const plan = String(planType || 'plus').toLowerCase();
    const patterns = PLAN_UPGRADE_PATTERNS[plan] || PLAN_UPGRADE_PATTERNS.plus;
    console.log(`📦 [步骤] 正在点击升级按钮 (套餐: ${plan})...`);

    await assertChatGptLoggedIn(page, '升级前');
    await dismissPricingOverlays(page);
    await switchToPersonalPlans(page);
    await dismissPricingOverlays(page);
    await page.waitForTimeout(1000);

    for (const pattern of patterns) {
        for (const role of ['button', 'link']) {
            try {
                const btn = page.getByRole(role, { name: pattern }).first();
                if (await btn.isVisible({ timeout: 4000 })) {
                    await btn.scrollIntoViewIfNeeded().catch(() => {});
                    await btn.click({ timeout: 10000 });
                    console.log(`✅ [步骤] 已点击升级按钮: ${pattern}`);
                    return;
                }
            } catch (_) { /* try next */ }
        }
    }

    const cardTitle = plan === 'plus' ? /ChatGPT Plus/i : /ChatGPT Pro/i;
    try {
        const card = page.locator('div').filter({ hasText: cardTitle }).filter({ has: page.getByRole('button') }).first();
        const btn = card.getByRole('button').filter({ hasText: /升级|Upgrade|Subscribe|Get|Try|Free|免费/i }).first();
        if (await btn.isVisible({ timeout: 3000 })) {
            await btn.scrollIntoViewIfNeeded().catch(() => {});
            await btn.click({ timeout: 10000 });
            console.log('✅ [步骤] 已点击套餐卡片内的升级按钮');
            return;
        }
    } catch (_) { /* fall through */ }

    if (plan === 'plus') {
        try {
            const plusCard = page.locator('div').filter({ has: page.getByText(/ChatGPT Plus|^Plus$/i) }).filter({
                has: page.getByRole('button', { name: /^Upgrade$|^升级$/i })
            }).first();
            const upgradeBtn = plusCard.getByRole('button', { name: /^Upgrade$|^升级$/i }).first();
            if (await upgradeBtn.isVisible({ timeout: 3000 })) {
                await upgradeBtn.scrollIntoViewIfNeeded().catch(() => {});
                await upgradeBtn.click({ timeout: 10000 });
                console.log('✅ [步骤] 已点击 Plus 卡片 Upgrade 按钮');
                return;
            }
        } catch (_) { /* fall through */ }
    }

    const fallbackSelectors = plan === 'plus'
        ? [
            'button:has-text("升级至 Plus")',
            'button:has-text("Upgrade to Plus")',
            'button:has-text("Try Plus")',
            'a:has-text("Try Plus")',
            'button:has-text("Get started")',
            'a:has-text("Get started")',
            '[role="dialog"] >> text=ChatGPT Plus >> .. >> .. >> button:has-text("Upgrade")',
            'text=ChatGPT Plus >> xpath=ancestor::div[.//button[contains(., "Upgrade") or contains(., "升级")]][1] >> button'
        ]
        : [
            'button:has-text("升级至 Pro")',
            'button:has-text("Upgrade to Pro")',
            'text=ChatGPT Pro >> xpath=ancestor::div[.//button[contains(., "Upgrade") or contains(., "升级")]][1] >> button'
        ];

    for (const sel of fallbackSelectors) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 3000 })) {
                await btn.scrollIntoViewIfNeeded().catch(() => {});
                await btn.click({ timeout: 10000 });
                console.log(`✅ [步骤] 已点击升级按钮 (${sel})`);
                return;
            }
        } catch (_) { /* try next */ }
    }

    const onLogin = await page.locator('text=Sign in with Google').isVisible({ timeout: 1000 }).catch(() => false);
    if (onLogin) {
        throw new Error('Session 未生效：定价页显示 Google 登录，无法点击升级按钮');
    }

    if (await isBusinessPlanView(page)) {
        throw new Error(`定价页仍在 Business 视图，未找到 ${plan} 套餐；请确认账号可升级 Plus/Pro`);
    }

    throw new Error(`未找到 ${plan} 套餐的升级按钮，请确认账号可升级且 Session 已登录`);
}

function isCheckoutLikeUrl(value) {
    const url = String(value || '');
    return /chatgpt\.com\/checkout|pay\.openai\.com|\/c\/pay\//i.test(url);
}

function extractCheckoutUrlFromPayload(data) {
    if (!data || typeof data !== 'object') {
        return '';
    }
    const direct = String(data.url || data.checkout_url || '').trim();
    if (/^https?:/i.test(direct)) {
        return direct;
    }
    const sessionId = String(
        data.checkout_session_id
        || data.checkoutSessionId
        || data.session_id
        || data.sessionId
        || ''
    ).trim();
    if (sessionId) {
        return `https://chatgpt.com/checkout/openai_llc/${sessionId}`;
    }
    const json = JSON.stringify(data);
    const match = json.match(/(cs_(?:live|test)_[A-Za-z0-9]+|oaics_[a-f0-9]+)/i);
    return match ? `https://chatgpt.com/checkout/openai_llc/${match[1]}` : '';
}

function captureCheckoutSession(page) {
    const captured = { url: '', sessionId: '' };
    const handler = (response) => {
        const responseUrl = response.url();
        const directMatch = responseUrl.match(/(cs_(?:live|test)_[A-Za-z0-9]+|oaics_[a-f0-9]+)/i);
        if (directMatch && !captured.sessionId) {
            captured.sessionId = directMatch[1];
        }
        const location = String(response.headers()?.location || '');
        if (!captured.url && isCheckoutLikeUrl(location)) {
            captured.url = location;
        }
        if (!/checkout|payments/i.test(responseUrl)) {
            return;
        }
        response.json().then((data) => {
            const url = extractCheckoutUrlFromPayload(data);
            if (url && !captured.url) {
                captured.url = url;
                console.log(`🔗 [Checkout] 已捕获支付地址: ${url.slice(0, 120)}...`);
            }
        }).catch(() => {});
    };
    page.on('response', handler);
    return {
        captured,
        dispose: () => page.off('response', handler)
    };
}

function getCheckoutFrameUrl(page) {
    const urls = [page.url(), ...page.frames().map((frame) => frame.url())];
    return urls.find((url) => isCheckoutLikeUrl(url)) || '';
}

function getCheckoutPageFromContext(page) {
    if (!page || typeof page.context !== 'function') return null;
    const pages = page.context().pages() || [];
    return pages.find((item) => item && !item.isClosed() && item !== page && isCheckoutLikeUrl(item.url())) || null;
}

async function pageOrFramesHasText(page, pattern) {
    const targets = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
    for (const target of targets) {
        try {
            if (await target.getByText(pattern).first().isVisible({ timeout: 1200 })) {
                return true;
            }
        } catch (_) { /* try next target */ }
    }
    return false;
}

async function clickCheckoutRetry(page) {
    const targets = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
    for (const target of targets) {
        try {
            const retry = target.getByRole('button', { name: /Retry|重试/i }).first();
            if (await retry.isVisible({ timeout: 1200 })) {
                await retry.click({ timeout: 5000 });
                return true;
            }
        } catch (_) { /* try next target */ }
    }
    return false;
}

async function waitForCheckoutPage(page, timeout = 60000, captured = null) {
    console.log('💳 [步骤] 等待跳转到 Checkout 配置套餐页...');
    const deadline = Date.now() + timeout;
    let retries = 0;

    while (Date.now() < deadline) {
        const popupCheckout = getCheckoutPageFromContext(page);
        const url = getCheckoutFrameUrl(page) || (popupCheckout ? popupCheckout.url() : '');
        if (url) {
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(2000);
            await assertChatGptLoggedIn(page, 'Checkout');
            console.log(`✅ [步骤] Checkout 页面已打开: ${url.slice(0, 120)}...`);
            return url;
        }
        const currentUrl = page.url();
        if (currentUrl.includes('accounts.google.com')) {
            throw new Error('Session 未生效：升级后跳转到 Google 登录页');
        }

        const snag = await pageOrFramesHasText(page, /ChatGPT hit a snag|Something went wrong while|We're having trouble/i);
        if (snag) {
            throw new Error('ChatGPT 返回错误页（ChatGPT hit a snag），创建 Checkout 被服务端拒绝；通常是账号/地区/代理风控导致，请更换环境后重试');
        }

        const configureVisible = await pageOrFramesHasText(page, /Configure your plan/i);
        if (configureVisible) {
            const formFailed = await pageOrFramesHasText(page, /Unable to load payment form/i);
            if (formFailed) {
                if (retries < 3) {
                    retries += 1;
                    console.log(`⚠️ [Checkout] 支付表单加载失败，正在点击 Retry (${retries}/3)...`);
                    await clickCheckoutRetry(page);
                    await page.waitForTimeout(5000);
                    continue;
                }
                if (captured?.url) {
                    console.warn('[Warn] 支付表单加载失败，但已捕获 Checkout 地址，将继续返回该地址');
                    return captured.url;
                }
                throw new Error('Checkout 配置页已打开，但支付表单持续加载失败（Unable to load payment form），通常是代理/风控导致');
            }

            if (captured?.url) {
                console.log('✅ [步骤] 已进入 Checkout 配置页，并使用捕获到的支付地址');
                return captured.url;
            }
        }

        if (captured?.url && Date.now() + 3000 >= deadline) {
            return captured.url;
        }
        await page.waitForTimeout(1000);
    }

    if (captured?.url) {
        console.log('✅ [步骤] 使用捕获到的 Checkout 支付地址');
        return captured.url;
    }
    throw new Error(`等待 Checkout 页面超时，当前 URL: ${page.url()}`);
}

async function openPricingCheckout(page, { region, planType }) {
    const capture = captureCheckoutSession(page);
    try {
        await waitForPricingPage(page);
        await switchToPersonalPlans(page);
        await selectPricingRegion(page, region);
        await clickPlanUpgrade(page, planType);
        const checkoutUrl = await waitForCheckoutPage(page, 60000, capture.captured);
        const popup = getCheckoutPageFromContext(page);
        if (popup) {
            const popupUrl = popup.url();
            console.log('[Checkout] 检测到 Checkout 在新标签页打开，正在切回当前标签页继续支付');
            await page.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await popup.close().catch(() => {});
        }
        return checkoutUrl || capture.captured.url;
    } finally {
        capture.dispose();
    }
}

module.exports = {
    PRICING_URL,
    openPricingCheckout,
    waitForPricingPage,
    selectPricingRegion,
    switchToPersonalPlans,
    clickPlanUpgrade,
    waitForCheckoutPage,
    pageShowsTargetRegionPricing,
    extractCheckoutUrlFromPayload,
    isCheckoutLikeUrl
};
