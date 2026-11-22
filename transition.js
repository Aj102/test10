/* Page-change animation for every page of the CFSI Student Portfolio.
   Add <script src="transition.js"></script> inside <head> of each page. */
(function () {
    var DURATION   = 350; // ms, page fade in/out
    var TEXT_DELAY = 300; // ms, how long the text waits after the page starts fading in
    var TEXT_FADE  = 500; // ms, how long the text takes to fade in

    // Text only fades in while the page is first loading, so search results,
    // modals and re-rendered cards don't keep flashing later.
    var root = document.documentElement;
    root.classList.add('cfsi-intro');
    setTimeout(function () { root.classList.remove('cfsi-intro'); },
               DURATION + TEXT_DELAY + TEXT_FADE + 200);

    var textSelector =
        'html.cfsi-intro h1, html.cfsi-intro h2, html.cfsi-intro h3, html.cfsi-intro h4, ' +
        'html.cfsi-intro h5, html.cfsi-intro h6, html.cfsi-intro p, html.cfsi-intro label, ' +
        'html.cfsi-intro li, html.cfsi-intro a, html.cfsi-intro button, html.cfsi-intro span, ' +
        'html.cfsi-intro strong, html.cfsi-intro blockquote, html.cfsi-intro input, ' +
        'html.cfsi-intro select, html.cfsi-intro textarea';

    var css = document.createElement('style');
    css.textContent =
        '@keyframes cfsiPageIn{from{opacity:0}to{opacity:1}}' +
        '@keyframes cfsiTextIn{from{opacity:0}}' +
        'body{animation:cfsiPageIn ' + DURATION + 'ms ease-out both}' +
        textSelector + '{animation:cfsiTextIn ' + TEXT_FADE + 'ms ease-out ' + TEXT_DELAY + 'ms backwards}' +
        'body.cfsi-leaving{animation:none;opacity:0;' +
        'transition:opacity ' + DURATION + 'ms ease;pointer-events:none}' +
        '@media (prefers-reduced-motion:reduce){body{animation:none}' +
        textSelector + '{animation:none}body.cfsi-leaving{transition:none}}';
    document.head.appendChild(css);

    document.addEventListener('click', function (e) {
        var a = e.target.closest && e.target.closest('a[href]');
        if (!a || e.defaultPrevented || e.button !== 0) return;
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        if (a.target && a.target !== '_self') return;
        if (a.hasAttribute('download')) return;

        var href = a.getAttribute('href');
        if (!href || href.charAt(0) === '#' || /^(mailto:|tel:|javascript:)/i.test(href)) return;
        if (a.origin !== location.origin) return;                 // external site
        if (a.pathname === location.pathname && a.search === location.search) return; // same page / hash

        e.preventDefault();
        document.body.classList.add('cfsi-leaving');
        setTimeout(function () { window.location.href = a.href; }, DURATION);
    });

    // Back/forward button restores the page from cache: undo the fade-out
    window.addEventListener('pageshow', function (e) {
        if (e.persisted) document.body.classList.remove('cfsi-leaving');
    });
})();