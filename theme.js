/* ============================================================
   CFSI Student Portfolio - Site-wide color theme settings
   ============================================================ */
(function () {
    "use strict";

    if (window.__cfsiThemeLoaded) return;
    window.__cfsiThemeLoaded = true;

    const STORAGE_KEY = "cfsi_theme";
    const DEFAULT_THEME = "blue";
    const THEMES = [
        { id: "blue", label: "School Blue" },
        { id: "white", label: "White" },
        { id: "black", label: "Black" },
        { id: "red", label: "Red" },
        { id: "pink", label: "Pink" },
        { id: "green", label: "Green" },
        { id: "yellow", label: "Yellow" },
        { id: "orange", label: "Orange" },
        { id: "purple", label: "Purple" },
        { id: "teal", label: "Teal" }
    ];
    const THEME_IDS = new Set(THEMES.map(theme => theme.id));
    const AUTH_PAGE_CLASSES = ["page-login", "page-signup", "page-signup1", "page-parent-signup"];

    const COLOR_RULES = [
        ["#0c5cbe", "--brand"],
        ["#1360ab", "--brand"],
        ["#21527d", "--brand"],
        ["#0a4d9e", "--brand-dark"],
        ["#094694", "--brand-dark"],
        ["#0b2545", "--ink"],
        ["#dc9e24", "--accent"],
        ["#f7f0dd", "--cream"],
        ["#f2ecca", "--cream"],
        ["#fef3c7", "--accent-soft"],
        ["#eff6ff", "--tint"],
        ["#dbeafe", "--tint-2"],
        ["#bfdbfe", "--tint-border"],
        ["#93c5fd", "--tint-border"],
        ["#60a5fa", "--brand-light"],
        ["#3b82f6", "--brand-light"],
        ["#2563eb", "--brand-light"],
        ["#1d4ed8", "--brand-light"],
        ["#f8fafc", "--surface-2"],
        ["#fafafa", "--surface-2"],
        ["#f1f5f9", "--surface-3"],
        ["#e2e8f0", "--border"],
        ["#cbd5e1", "--border-strong"],
        ["#0f172a", "--text"],
        ["#334155", "--text-soft"],
        ["#475569", "--text-soft"],
        ["#64748b", "--text-muted"],
        ["#94a3b8", "--text-faint"]
    ].map(([hex, token]) => [
        new RegExp(hex + "(?![0-9a-fA-F])", "gi"),
        "var(" + token + ")"
    ]);

    let lastFocused = null;

    function applyColorTokens(text) {
        if (!text || text.indexOf("#") === -1) return text;
        return COLOR_RULES.reduce(
            (value, [pattern, replacement]) => value.replace(pattern, replacement),
            text
        );
    }

    function themeInlineElement(element) {
        const current = element.getAttribute("style");
        if (!current) return;
        const next = applyColorTokens(current);
        if (next !== current) element.setAttribute("style", next);
    }

    function themeInlineStyles(root) {
        if (!root) return;
        if (root.nodeType === 1 && root.hasAttribute("style")) themeInlineElement(root);
        if (root.querySelectorAll) root.querySelectorAll("[style]").forEach(themeInlineElement);
    }

    function themeStyleBlocks() {
        document.querySelectorAll("style").forEach(element => {
            if (element.dataset.cfsiThemed === "true") return;
            const current = element.textContent;
            const next = applyColorTokens(current);
            if (next !== current) element.textContent = next;
            element.dataset.cfsiThemed = "true";
        });
    }

    function readSavedTheme() {
        try {
            return localStorage.getItem(STORAGE_KEY);
        } catch (error) {
            return null;
        }
    }

    function saveTheme(id) {
        try {
            localStorage.setItem(STORAGE_KEY, id);
        } catch (error) {
            /* Private mode or storage disabled: the theme still applies for this visit. */
        }
    }

    function normalizeTheme(id) {
        return THEME_IDS.has(id) ? id : DEFAULT_THEME;
    }

    function themeLabel(id) {
        const found = THEMES.find(theme => theme.id === id);
        return found ? found.label : "School Blue";
    }

    const initialTheme = normalizeTheme(readSavedTheme());
    document.documentElement.setAttribute("data-theme", initialTheme);

    function updateMetaColor() {
        let meta = document.querySelector('meta[name="theme-color"]');
        if (!meta) {
            meta = document.createElement("meta");
            meta.setAttribute("name", "theme-color");
            document.head.appendChild(meta);
        }

        const brand = getComputedStyle(document.documentElement)
            .getPropertyValue("--brand")
            .trim();
        if (brand) meta.setAttribute("content", brand);
    }

    function updateOptions(theme) {
        document.querySelectorAll(".cfsi-theme-option").forEach(option => {
            option.setAttribute("aria-checked", String(option.dataset.theme === theme));
        });
    }

    function applyTheme(id, options) {
        const settings = options || {};
        const theme = normalizeTheme(id);

        document.documentElement.setAttribute("data-theme", theme);

        if (settings.persist !== false) saveTheme(theme);

        updateOptions(theme);
        updateMetaColor();

        const status = document.getElementById("cfsiThemeStatus");
        if (status && settings.announceText) status.textContent = settings.announceText;
    }

    function buildSettingsButton() {
        const button = document.createElement("button");
        button.type = "button";
        button.id = "cfsiThemeBtn";
        button.className = "cfsi-theme-btn";
        button.setAttribute("aria-haspopup", "dialog");
        button.setAttribute("aria-controls", "cfsiThemeModal");
        button.title = "Appearance settings";
        button.innerHTML =
            '<i class="fa-solid fa-gear" aria-hidden="true"></i><span>Settings</span>';
        button.addEventListener("click", openModal);
        return button;
    }

    function mountSettingsButton() {
        if (document.getElementById("cfsiThemeBtn")) return;
        if (AUTH_PAGE_CLASSES.some(name => document.body.classList.contains(name))) return;

        const button = buildSettingsButton();
        const homeGroup = document.getElementById("hp");
        if (homeGroup) {
            homeGroup.appendChild(button);
            return;
        }

        const landingNav = document.querySelector(".navbar .nav");
        if (landingNav) {
            landingNav.appendChild(button);
            return;
        }

        button.classList.add("cfsi-theme-floating");
        document.body.appendChild(button);
    }

    function buildModal() {
        if (document.getElementById("cfsiThemeModal")) return;

        const wrapper = document.createElement("div");
        wrapper.id = "cfsiThemeModal";
        wrapper.className = "cfsi-theme-modal";
        wrapper.setAttribute("aria-hidden", "true");
        wrapper.innerHTML = [
            '<div class="cfsi-theme-backdrop" data-cfsi-close></div>',
            '<div class="cfsi-theme-dialog" role="dialog" aria-modal="true" aria-labelledby="cfsiThemeTitle" aria-describedby="cfsiThemeDesc">',
            '  <div class="cfsi-theme-head">',
            '    <div>',
            '      <h2 id="cfsiThemeTitle">Appearance</h2>',
            '      <p id="cfsiThemeDesc">Pick a color theme for the whole website. Your choice is saved on this device.</p>',
            '    </div>',
            '    <button type="button" class="cfsi-theme-close" data-cfsi-close aria-label="Close settings">&times;</button>',
            '  </div>',
            '  <div class="cfsi-theme-grid" role="radiogroup" aria-label="Color themes"></div>',
            '  <div class="cfsi-theme-foot">',
            '    <span id="cfsiThemeStatus" role="status" aria-live="polite"></span>',
            '    <button type="button" id="cfsiThemeReset">Reset to school blue</button>',
            '  </div>',
            '</div>'
        ].join("");

        document.body.appendChild(wrapper);

        const grid = wrapper.querySelector(".cfsi-theme-grid");
        THEMES.forEach(theme => {
            const option = document.createElement("button");
            option.type = "button";
            option.className = "cfsi-theme-option";
            option.dataset.theme = theme.id;
            option.setAttribute("role", "radio");
            option.setAttribute("aria-checked", "false");
            option.innerHTML =
                '<span class="cfsi-swatch" aria-hidden="true"></span><span>' + theme.label + "</span>";
            option.addEventListener("click", () => {
                applyTheme(theme.id, {
                    persist: true,
                    announceText: theme.label + " theme applied."
                });
            });
            grid.appendChild(option);
        });

        grid.addEventListener("keydown", event => {
            const options = Array.from(grid.querySelectorAll(".cfsi-theme-option"));
            const currentIndex = options.indexOf(document.activeElement);
            if (currentIndex < 0) return;

            let nextIndex = null;
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                nextIndex = (currentIndex + 1) % options.length;
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                nextIndex = (currentIndex - 1 + options.length) % options.length;
            } else if (event.key === "Home") {
                nextIndex = 0;
            } else if (event.key === "End") {
                nextIndex = options.length - 1;
            }

            if (nextIndex !== null) {
                event.preventDefault();
                options[nextIndex].focus();
            }
        });

        wrapper.querySelectorAll("[data-cfsi-close]").forEach(element => {
            element.addEventListener("click", closeModal);
        });

        wrapper.querySelector("#cfsiThemeReset").addEventListener("click", () => {
            applyTheme(DEFAULT_THEME, {
                persist: true,
                announceText: "School Blue theme restored."
            });
        });

        wrapper.addEventListener("keydown", trapFocus);
    }

    function trapFocus(event) {
        if (event.key !== "Tab") return;

        const modal = document.getElementById("cfsiThemeModal");
        if (!modal) return;

        const focusable = Array.from(
            modal.querySelectorAll(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            )
        ).filter(element => !element.disabled && element.offsetParent !== null);

        if (!focusable.length) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function openModal() {
        const modal = document.getElementById("cfsiThemeModal");
        if (!modal) return;

        lastFocused = document.activeElement;
        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");
        document.body.classList.add("cfsi-theme-modal-open");

        const selected =
            modal.querySelector('.cfsi-theme-option[aria-checked="true"]') ||
            modal.querySelector(".cfsi-theme-option");

        if (selected) selected.focus();
    }

    function closeModal() {
        const modal = document.getElementById("cfsiThemeModal");
        if (!modal) return;

        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("cfsi-theme-modal-open");

        const fallback = document.getElementById("cfsiThemeBtn");
        const target = lastFocused && lastFocused !== document.body ? lastFocused : fallback;
        if (target && typeof target.focus === "function") target.focus();
    }

    function initThemeUI() {
        mountSettingsButton();
        buildModal();
        applyTheme(document.documentElement.getAttribute("data-theme"), { persist: false });
        themeInlineStyles(document);
        themeStyleBlocks();

        const modal = document.getElementById("cfsiThemeModal");
        if (modal) {
            modal.addEventListener("click", event => {
                if (event.target === modal) closeModal();
            });
        }

        if (window.MutationObserver) {
            const observer = new MutationObserver(records => {
                records.forEach(record => {
                    record.addedNodes.forEach(node => {
                        if (!node || node.nodeType !== 1) return;
                        if (node.tagName === "STYLE") {
                            themeStyleBlocks();
                            return;
                        }
                        themeInlineStyles(node);
                        if (node.querySelector && node.querySelector("style")) themeStyleBlocks();
                    });
                });
            });

            observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    document.addEventListener("keydown", event => {
        const modal = document.getElementById("cfsiThemeModal");
        if (event.key === "Escape" && modal && modal.classList.contains("open")) {
            closeModal();
        }
    });

    window.addEventListener("storage", event => {
        if (event.key === STORAGE_KEY && THEME_IDS.has(event.newValue)) {
            applyTheme(event.newValue, {
                persist: false,
                announceText: themeLabel(event.newValue) + " theme updated in another tab."
            });
        }
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initThemeUI);
    } else {
        initThemeUI();
    }
})();