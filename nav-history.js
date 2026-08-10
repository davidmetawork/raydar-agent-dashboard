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

   Pages use:
     RaydarNav.tabs({names, current, show})  owner only, once at startup
     RaydarNav.tab(name)                     owner only, the user picked a tab
     RaydarNav.open(name, close)             a screen just opened
     RaydarNav.back(name)                    an in-app control closed it
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

  const currentTab = () => (tabs ? tabs.current() : "");
  const entry = (tab, depth) => ({ raydarNav: { tab: tab, depth: depth } });

  // A tab named by the URL, for entries we did not write ourselves — a
  // bookmark, a hand-typed address, a link opened in a new tab.
  function tabFromUrl() {
    if (!tabs) return "";
    const hash = location.hash.replace(/^#/, "");
    return tabs.names.includes(hash) ? hash : tabs.names[0];
  }

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

  function post(action, name) {
    try {
      window.parent.postMessage({ type: MESSAGE, action: action, name: name }, origin);
    } catch (error) {/* a foreign parent simply gets no in-app back */}
  }

  function runCloser(name) {
    const close = closers.get(name);
    if (!close) return;   // an in-app control already closed it
    closers.delete(name);
    try { close(); } catch (error) {/* a broken screen must not wedge history */}
  }

  function ownerOpen(win, name) {
    // A screen that re-opens itself (a detail reloading after an action) must
    // not stack a second entry for the user to walk back through.
    if (stack.some((screen) => screen.win === win && screen.name === name)) return;
    stack.push({ win: win, name: name });
    history.pushState(entry(currentTab(), stack.length), "");
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
    if (data.action === "open") ownerOpen(event.source, data.name);
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
      tabs = config;
      history.replaceState(entry(config.current(), stack.length), "");
    },
    tab: function (name) {
      if (embedded || !tabs) return;
      history.pushState(entry(name, stack.length), "", "#" + name);
    },
    open: function (name, close) {
      const known = closers.has(name);
      closers.set(name, close);
      if (known) return;   // same screen, same entry — new contents only
      if (embedded) post("open", name);
      else ownerOpen(window, name);
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
  });
})();
