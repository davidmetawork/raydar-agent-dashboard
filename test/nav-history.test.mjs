import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const ORIGIN = "https://monitor.raydar.xyz";
const source = await readFile(new URL("../nav-history.js", import.meta.url), "utf8");

/* A browser small enough to reason about: a real entry list, a real index, and
   popstate delivered from whichever entry the index lands on. history.go() is
   synchronous here — the ordering it exercises is what matters, not the tick. */
function browser() {
  const frames = [];

  function frame(parent) {
    const listeners = new Map();
    const entries = [{ state: null, url: "/" }];
    let index = 0;

    const dispatch = (type, event) => {
      for (const fn of listeners.get(type) || []) fn(event);
    };

    const win = {
      console,
      location: { origin: ORIGIN, get hash() { return (entries[index].url.split("#")[1] || "") && "#" + entries[index].url.split("#")[1]; } },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      postMessage(data, targetOrigin, source) {
        assert.equal(targetOrigin, ORIGIN, "postMessage must be pinned to our own origin");
        dispatch("message", { origin: ORIGIN, data, source });
      },
      history: {
        pushState(state, _title, url) {
          entries.length = index + 1;
          entries.push({ state, url: url == null ? entries[index].url : url });
          index = entries.length - 1;
        },
        replaceState(state, _title, url) {
          entries[index] = { state, url: url == null ? entries[index].url : url };
        },
        go(delta) {
          const next = Math.max(0, Math.min(entries.length - 1, index + delta));
          if (next === index) return;
          const before = entries[index].url;
          index = next;
          dispatch("popstate", { state: entries[index].state });
          if (entries[index].url !== before) dispatch("hashchange", {});
        },
      },
      // test handles
      entries,
      get index() { return index; },
      back() { win.history.go(-1); },
      forward() { win.history.go(1); },
    };
    win.window = win;
    win.parent = parent || win;
    vm.createContext(win);
    vm.runInContext(source, win);
    frames.push(win);
    return win;
  }

  return { frame };
}

/* An embedded page: its parent is the shell, and postMessage in both
   directions carries the sending window as `source`, exactly as a browser
   does for a same-origin iframe. */
function shellWithFrame() {
  const { frame } = browser();
  const shell = frame();
  const guestBox = {};
  const guestParent = {
    postMessage(data, targetOrigin) { shell.postMessage(data, targetOrigin, guestBox.win); },
  };
  const guest = frame(guestParent);
  guestBox.win = guest;
  // the shell posts back to the frame with itself as the source
  const rawPost = guest.postMessage;
  guest.postMessage = (data, targetOrigin) => rawPost.call(guest, data, targetOrigin, guestParent);
  guest.parent = guestParent;
  return { shell, guest };
}

function tabbedShell() {
  const { shell, guest } = shellWithFrame();
  const shown = [];
  let current = "overview";
  shell.RaydarNav.tabs({
    names: ["overview", "candidates", "activity"],
    current: () => current,
    show: (name) => { current = name; shown.push(name); },
  });
  return { shell, guest, tab: (name) => { current = name; shell.RaydarNav.tab(name); }, view: () => current, shown };
}

test("a drill-in becomes a real history entry, and back closes it", () => {
  const { frame } = browser();
  const page = frame();
  let open = true;
  page.RaydarNav.open("thread", () => { open = false; });

  assert.equal(page.entries.length, 2, "the screen should have pushed one entry");
  page.back();
  assert.equal(open, false, "back should close the screen");
  assert.equal(page.index, 0, "and land on the entry the user came from");
});

test("re-opening the same screen does not stack a second entry to walk back through", () => {
  const { frame } = browser();
  const page = frame();
  let closes = 0;
  page.RaydarNav.open("thread", () => { closes += 1; });
  page.RaydarNav.open("thread", () => { closes += 1; });   // a detail reloading after an action
  assert.equal(page.entries.length, 2);
  page.back();
  assert.equal(closes, 1);
});

test("the in-app back button unwinds its own entry, so one more back leaves the page", () => {
  const { frame } = browser();
  const page = frame();
  let open = true;
  page.RaydarNav.open("thread", () => { open = false; });
  assert.equal(page.RaydarNav.back("thread"), true);
  assert.equal(open, false, "the button closes the screen immediately");
  assert.equal(page.index, 0, "and rewinds history behind it — no dead back press left over");
});

test("back() reports an unregistered screen so the caller can still close it", () => {
  const { frame } = browser();
  const page = frame();
  assert.equal(page.RaydarNav.back("thread"), false);
});

test("an embedded page delegates to the shell instead of pushing its own entry", () => {
  const { shell, guest } = shellWithFrame();
  let open = true;
  guest.RaydarNav.open("thread", () => { open = false; });

  assert.equal(guest.entries.length, 1, "the frame must not write history itself");
  assert.equal(shell.entries.length, 2, "the shell owns the entry");
  shell.back();
  assert.equal(open, false, "and a back gesture reaches the frame that opened the screen");
});

test("back walks the screen first and the tab second", () => {
  const { shell, guest, tab, view } = tabbedShell();
  tab("activity");
  let open = true;
  guest.RaydarNav.open("thread", () => { open = false; });

  shell.back();
  assert.equal(open, false, "first back closes the thread");
  assert.equal(view(), "activity", "and stays on the tab it was opened from");

  shell.back();
  assert.equal(view(), "overview", "second back returns to the previous tab");
  assert.equal(shell.index, 0, "which is the entry the dashboard loaded on");
});

test("a screen left open in another tab still unwinds last", () => {
  const { shell, guest, tab, view } = tabbedShell();
  tab("activity");
  let open = true;
  guest.RaydarNav.open("thread", () => { open = false; });
  tab("candidates");

  shell.back();
  assert.equal(view(), "activity", "back out of the tab switch first");
  assert.equal(open, true, "the thread is still open underneath it");
  shell.back();
  assert.equal(open, false, "and the next back closes it");
});

test("forward into a screen that no longer exists leaves history honest", () => {
  const { frame } = browser();
  const page = frame();
  page.RaydarNav.open("thread", () => {});
  page.back();
  page.forward();
  // the state object is built inside the vm realm, so compare its shape
  assert.equal(page.entries[page.index].state.raydarNav.depth, 0,
    "the entry should be rewritten to the depth actually on screen");
  page.back();   // must not throw or double-close
});

test("every screen a dashboard page opens is wired for the back gesture", async () => {
  const pages = ["index.html", "activity.html", "applicants.html", "inbox.html"];
  for (const page of pages) {
    const html = await readFile(new URL(`../${page}`, import.meta.url), "utf8");
    assert.match(html, /<script src="\/nav-history\.js"><\/script>/, `${page} should load the nav helper`);
    assert.match(html, /RaydarNav\.(open|tab)\(/, `${page} should register its screens`);
  }
});

test("the nav helper is served without the sign-in gate, like auth-session.js", async () => {
  const middleware = await readFile(new URL("../middleware.ts", import.meta.url), "utf8");
  assert.match(middleware, /nav-history\\\\\.js\$/);
});

test("a hash navigation the shell did not make still lands on the right tab", () => {
  const { shell, tab, view } = tabbedShell();
  tab("candidates");
  // a bookmark, a typed address, a stray in-page link: the browser makes the
  // entry itself, so nothing carries our state
  shell.entries.push({ state: null, url: "/#activity" });
  shell.history.go(1);
  assert.equal(view(), "activity", "the tab should follow the URL");
  assert.equal(shell.entries[shell.index].state.raydarNav.tab, "activity",
    "and the entry should be stamped so back/forward keeps working");
});
