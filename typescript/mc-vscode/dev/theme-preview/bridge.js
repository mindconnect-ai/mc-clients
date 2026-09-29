/*
 * PROTOTYPE of the Admin UI's host bridge — the receiving end of the
 * extension's mc-host-theme message (see the extension README, "Host theme").
 * Injected into <head> by serve.mjs, after the page's own theme script.
 */
(function () {
    var root = document.documentElement;
    var url = new URL(window.location.href);
    var host = url.searchParams.get("mc-host");
    try {
        if (host) sessionStorage.setItem("sui-host", host);
        else host = sessionStorage.getItem("sui-host");
    } catch (e) { /* storage off: host mode only on the first page */ }
    if (host !== "vscode") return;

    // Host mode: the host decides the look. Whatever theme this browser
    // remembers stays remembered (localStorage is not touched), it just is not on.
    Array.from(root.classList).forEach(function (c) {
        if (c.indexOf("sui-theme-") === 0) root.classList.remove(c);
    });
    root.classList.add("sui-theme-vscode", "sui-host-vscode");

    // VS Code names its variables in camelCase: --vscode-sideBar-background.
    var NAME = /^--vscode-[A-Za-z0-9-]+$/;
    var KINDS = ["dark", "light", "high-contrast", "high-contrast-light"];

    function trusted(event) {
        if (event.source !== window.parent) return false;
        return event.origin.indexOf("vscode-webview://") === 0 || event.origin === window.location.origin;
    }

    function safe(value) {
        return typeof value === "string" && value.length <= 200 && !/url\(|[;{}<]/i.test(value);
    }

    window.addEventListener("message", function (event) {
        var data = event.data;
        if (!data || data.type !== "mc-host-theme" || !trusted(event)) return;
        var vars = data.vars || {};
        // Each message is the whole set: a variable the new theme does not define
        // (--vscode-contrastBorder exists only in high contrast) must go, or it
        // outlives the theme that set it.
        Array.from(root.style).forEach(function (name) {
            if (name.indexOf("--vscode-") === 0 && !(name in vars)) root.style.removeProperty(name);
        });
        Object.keys(vars).forEach(function (name) {
            if (NAME.test(name) && safe(vars[name])) root.style.setProperty(name, vars[name]);
        });
        KINDS.forEach(function (k) { root.classList.toggle("sui-host-kind-" + k, k === data.kind); });
    });

    if (window.parent !== window) window.parent.postMessage({ type: "mc-host-ready" }, "*");
})();
