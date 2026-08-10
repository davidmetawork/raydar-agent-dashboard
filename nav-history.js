/* Raydar in-app back navigation.

   Every monitor.raydar.xyz surface is a single document: the tab bar swaps
   hidden sections, and a drill-in (an Activity thread, an applicant profile,
   an Inbox reading pane) is pure DOM state. None of that ever reached the
   browser's history, so a trackpad back-swipe left the dashboard entirely
   when the user only meant "back one screen".

   Exactly ONE frame owns the history: the top Raydar document — index.html
   when a page is embedded in the shell, the page itself when it is opened
   standalone at /activity, /inbox, /applicants. Embedded pages ask the owner
   over postMessage instead of pushing their own entries, so the shell's tab
   entries and a child's drill-in entries stay strictly last-in-first-out.
   Joint iframe session history gives no such guarantee — a lazily-loaded
   frame can rewrite entries the shell already pushed.

   A screen may also carry an ADDRESS — an opaque id for the thing on screen
   (a thread key, a candidate id, a message id). Addressed screens get a real
   URL, `#<tab>/<address>`, so a row can be a link the browser will happily
   open in a new tab, and a fresh load of that URL rebuilds the screen with
   its list seeded underneath it.

   Pages use:
     RaydarNav.tabs({names, current, show})  owner only, once at startup
     RaydarNav.tab(name)                     owner only, the user picked a tab
     RaydarNav.open(name, close, address)    a screen just opened
     RaydarNav.back(name)                    an in-app control closed it
     RaydarNav.href(address)                 the link to render on a row
     RaydarNav.restore(fn)                   rebuild the screen the URL names
     RaydarNav.screen(tab)                   owner only, for composing frame URLs
*/
(function () {
  const MESSAGE = "raydar-nav";
  const embedded = window.parent !== window;
  const origin = location.origin;

  // Screens THIS document opened: name -> the callback that closes it.
  const closers = new Map();

  // Owner only: every open screen across every frame, innermost last.
  const stack = [];
  let tabs = null;

  // The shell tells an embedded page which tab it lives in (and which screen
  // to rebuild) through its frame URL; a standalone page reads its own hash.
  const params = new URLSearchParams(location.search);
  const myTab = params.get("tab") || "";
  let restorer = null;
  let restored = false;

  const currentTab = () => (tabs ? tabs.current() : "");
  const entry = (tab, depth) => ({ raydarNav: { tab: tab, depth: depth } });

  // "#activity/app-42" -> { tab: "activity", screen: "app-42" }. A standalone
  // page has no tab segment, so the whole hash is the screen.
  function urlParts() {
    const raw = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!tabs) return { tab: "", screen: raw };
    const cut = raw.indexOf("/");
    if (cut < 0) return { tab: raw, screen: "" };
    return { tab: raw.slice(0, cut), screen: raw.slice(cut + 1) };
  }

  // A tab named by the URL, for entries we did not write ourselves — a
  // bookmark, a hand-typed address, a link opened in a new tab.
  function tabFromUrl() {
    if (!tabs) return "";
    const tab = urlParts().tab;
    return tabs.names.includes(tab) ? tab : tabs.names[0];
  }

  const screenUrl = (address) =>
    !address ? "" : "#" + encodeURI(tabs ? currentTab() + "/" + address : address);

  function readEntry(state) {
    const saved = state && state.raydarNav;
    if (!saved) return { tab: tabFromUrl(), depth: 0 };
    return {
      tab: saved.tab || tabFromUrl(),
      depth: typeof saved.depth === "number" ? saved.depth : 0,
    };
  }

  // A hash navigation nobody routed through us still has to land on the right
  // tab. pushState never fires this, so anything arriving here is external.
  function onHashChange() {
    if (!tabs) return;
    const hash = location.hash.replace(/^#/, "");
    if (!tabs.names.includes(hash) || hash === tabs.current()) return;
    tabs.show(hash);   // the browser already made the entry — adopt it
    history.replaceState(entry(hash, stack.length), "");
  }

  function post(action, name, address) {
    try {
      window.parent.postMessage({ type: MESSAGE, action: action, name: name, address: address }, origin);
    } catch (error) {/* a foreign parent simply gets no in-app back */}
  }

  function runCloser(name) {
    const close = closers.get(name);
    if (!close) return;   // an in-app control already closed it
    closers.delete(name);
    try { close(); } catch (error) {/* a broken screen must not wedge history */}
  }

  function ownerOpen(win, name, address) {
    // A screen that re-opens itself (a detail reloading after an action) must
    // not stack a second entry for the user to walk back through.
    if (stack.some((screen) => screen.win === win && screen.name === name)) return;
    stack.push({ win: win, name: name });
    const url = screenUrl(address);
    const state = entry(currentTab(), stack.length);
    // Rebuilding the screen the URL already names (a link opened in a new tab)
    // claims that entry rather than stacking a duplicate on top of it.
    if (url && decodeURIComponent(location.hash) === decodeURIComponent(url)) history.replaceState(state, "");
    else if (url) history.pushState(state, "", url);
    else history.pushState(state, "");
  }

  function ownerBack(win, name) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].win === win && stack[i].name === name) {
        history.go(-(stack.length - i));
        return;
      }
    }
  }

  function closeScreen(screen) {
    if (screen.win === window) { runCloser(screen.name); return; }
    try {
      screen.win.postMessage({ type: MESSAGE, action: "closed", name: screen.name }, origin);
    } catch (error) {/* the frame reloaded out from under us */}
  }

  function onPopState(event) {
    const want = readEntry(event.state);
    while (stack.length > want.depth) closeScreen(stack.pop());
    if (tabs && want.tab && want.tab !== tabs.current()) tabs.show(want.tab);
    // Make the entry honest: either it was never ours (a plain #hash entry we
    // just adopted) or it points at a screen we cannot rebuild going forward.
    const ours = event.state && event.state.raydarNav;
    if (!ours || want.depth !== stack.length) history.replaceState(entry(currentTab(), stack.length), "");
  }

  function onMessage(event) {
    if (event.origin !== origin) return;
    const data = event.data;
    if (!data || data.type !== MESSAGE) return;
    if (embedded) {
      if (data.action === "closed" && event.source === window.parent) runCloser(data.name);
      return;
    }
    if (!event.source) return;
    if (data.action === "open") ownerOpen(event.source, data.name, data.address);
    else if (data.action === "back") ownerBack(event.source, data.name);
  }

  window.addEventListener("message", onMessage);
  if (!embedded) {
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onHashChange);
  }

  window.RaydarNav = Object.freeze({
    // `show` must switch the view WITHOUT recording history: by the time it
    // runs, the browser has already moved the URL to the entry being restored.
    tabs: function (config) {
      if (embedded) return;
      const first = !tabs;
      tabs = config;
      if (!first) return;   // re-registering must not seed a second entry
      const landing = urlParts().screen;
      if (!landing) { history.replaceState(entry(config.current(), stack.length), ""); return; }
      // Landing straight on a screen — a row link opened in a new tab. Seed the
      // list entry beneath it, so back (and the screen's own ← Back button)
      // returns to the list instead of leaving the dashboard outright.
      const tab = tabFromUrl();
      history.replaceState(entry(config.current(), 0), "", "#" + tab);
      history.pushState(entry(config.current(), 0), "", "#" + encodeURI(tab + "/" + landing));
    },
    tab: function (name) {
      if (embedded || !tabs) return;
      history.pushState(entry(name, stack.length), "", "#" + name);
    },
    open: function (name, close, address) {
      const known = closers.has(name);
      closers.set(name, close);
      if (known) return;   // same screen, same entry — new contents only
      if (embedded) post("open", name, address);
      else ownerOpen(window, name, address);
    },
    // Closing from an in-app control (a "← Back" button). The screen closes
    // immediately and its history entry is unwound behind it, so the button
    // and the back gesture can never disagree about where the user is.
    // Returns false when the screen was never registered, so callers can fall
    // back to closing it directly.
    back: function (name) {
      if (!closers.has(name)) return false;
      runCloser(name);
      if (embedded) post("back", name);
      else ownerBack(window, name);
      return true;
    },
    // The link to put on a row. Embedded, it addresses the shell so a new tab
    // opens the whole dashboard focused on that screen; standalone, it
    // addresses this page. Rows stay ordinary links either way.
    href: function (address) {
      if (!address) return "";
      const suffix = "#" + encodeURI(embedded && myTab ? myTab + "/" + address : address);
      return embedded ? "/" + suffix : location.pathname + suffix;
    },
    // Rebuild the screen the URL names, once, after the page has data to
    // resolve it against. Safe to call on every refresh — it only fires once.
    restore: function (fn) {
      restorer = fn;
      if (restored) return;
      const screen = embedded ? params.get("screen") : urlParts().screen;
      if (!screen) return;
      restored = true;
      if (!embedded) {
        // Same seeding as the shell does: put the list underneath the screen.
        history.replaceState(entry(currentTab(), 0), "", location.pathname + location.search);
        history.pushState(entry(currentTab(), 0), "", "#" + encodeURI(screen));
      }
      try { fn(screen); } catch (error) {/* a screen we cannot rebuild just shows the list */}
    },
    // Owner only: the screen this URL names for `tab`, for composing frame URLs.
    screen: function (tab) {
      const parts = urlParts();
      return parts.tab === tab ? parts.screen : "";
    },
  });
})();
