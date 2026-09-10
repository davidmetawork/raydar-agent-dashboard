/* Master Inbox route + trust text. Pure functions, no DOM, no fetch.

   Two jobs, both of which have to be true in a unit test rather than in a
   screenshot:

   1. The screen ADDRESS. A Master Inbox screen is "browse" or
      "browse?<params>" with folder, mailbox, q and id. RaydarNav turns that
      into the top-level URL "#master-inbox/browse?..." so a row is a real
      link, a reload rebuilds the same screen, and the shell's back gesture
      unwinds it. `folder` is omitted when it is the default ("all"); an
      explicit "inbox" is kept because the rail shows the two separately even
      though the store resolves both to INBOX.

   2. The TRUST SENTENCES. What the status pill says, what an empty list says,
      and what the search box admits it ignored are derived here from the
      service's coverage object, so "current" can never be a hardcoded word
      again. Every formatter takes an injectable clock so tests assert exact
      strings instead of the runner's locale.
*/
(function () {
  "use strict";

  var FOLDERS = ["all", "inbox", "starred", "snoozed", "sent", "drafts", "spam", "trash", "all-mail"];
  var FOLDER_LABELS = {
    all: "All inboxes", inbox: "Inbox", starred: "Starred", snoozed: "Snoozed",
    sent: "Sent", drafts: "Drafts", spam: "Spam", trash: "Trash", "all-mail": "All Mail"
  };
  var DEFAULT_FOLDER = "all";
  var EMPTY_ROUTE = { folder: DEFAULT_FOLDER, mailbox: "", q: "", id: "" };
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function text(value, max) {
    return String(value === undefined || value === null ? "" : value).slice(0, max);
  }

  function normalizeRoute(input) {
    var source = input || {};
    var folder = text(source.folder, 40).trim().toLowerCase();
    var id = text(source.id, 80).trim();
    return {
      folder: FOLDERS.indexOf(folder) >= 0 ? folder : DEFAULT_FOLDER,
      mailbox: text(source.mailbox, 200).trim(),
      q: text(source.q, 1000).trim(),
      id: UUID.test(id) ? id.toLowerCase() : ""
    };
  }

  function serializeRoute(input) {
    var route = normalizeRoute(input);
    var params = new URLSearchParams();
    if (route.folder !== DEFAULT_FOLDER) params.set("folder", route.folder);
    if (route.mailbox) params.set("mailbox", route.mailbox);
    if (route.q) params.set("q", route.q);
    if (route.id) params.set("id", route.id);
    var query = params.toString();
    return query ? "browse?" + query : "browse";
  }

  function parseRoute(address) {
    var raw = text(address, 2000).trim();
    if (!raw || raw === "browse") return normalizeRoute({});
    // The pre-slice-1 page wrote "#conversation=<uuid>" into its own frame URL.
    if (raw.indexOf("conversation=") === 0) return normalizeRoute({ id: raw.slice("conversation=".length) });
    // A bare uuid address is a hand-built link straight to one conversation.
    if (raw.indexOf("?") < 0 && UUID.test(raw)) return normalizeRoute({ id: raw });
    var query = raw.indexOf("browse?") === 0 ? raw.slice("browse?".length) : raw.replace(/^\?/, "");
    return normalizeRoute(Object.fromEntries(new URLSearchParams(query)));
  }

  function sameRoute(a, b) {
    return serializeRoute(a) === serializeRoute(b);
  }

  function pad2(value) { return (value < 10 ? "0" : "") + value; }

  function clockTime(value) {
    if (!value) return "";
    var date = new Date(value);
    if (!isFinite(date.valueOf())) return "";
    try { return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
    catch (error) { return pad2(date.getHours()) + ":" + pad2(date.getMinutes()); }
  }

  function labelList(ids, label) {
    return (ids || []).map(function (id) { return label(id); }).filter(Boolean).join(", ");
  }

  // The mailboxes this response actually claims to cover. coverage.mailboxes
  // always lists the whole store, so the scope filter is what makes any claim
  // about "every mailbox in scope" true rather than approximately true.
  function scopedMailboxes(coverage) {
    var all = (coverage && coverage.mailboxes) || [];
    var scope = coverage && coverage.scope && coverage.scope.mailboxIds;
    if (!Array.isArray(scope) || !scope.length) return all.filter(Boolean);
    return all.filter(function (mailbox) { return mailbox && scope.indexOf(mailbox.id) >= 0; });
  }

  // Mailboxes whose historical import has not finished. The sync watermark
  // bounds the NEWEST edge of coverage only; a mailbox synced to the head can
  // still be missing years of older mail, so these mailboxes make any claim of
  // absence over old mail false.
  function incompleteHistory(coverage) {
    return scopedMailboxes(coverage).filter(function (mailbox) {
      return !mailbox.history || mailbox.history.importState !== "complete";
    });
  }

  function plural(count, word) {
    return count + " " + word + (count === 1 ? "" : word === "mailbox" ? "es" : "s");
  }

  // The status pill. tone drives the colour; text is the whole claim; detail is
  // the hover, which names the mailboxes behind a summary number and says when
  // the claim was read, so a page left open does not look freshly true.
  function coverageSummary(coverage, options) {
    var settings = options || {};
    var label = settings.label || function (id) { return id; };
    var clock = settings.clock || clockTime;
    var readAt = clock(coverage && coverage.asOf);
    function done(result) {
      if (readAt) result.detail = result.detail + " · Read at " + readAt;
      return result;
    }
    var summary = coverage && coverage.summary;
    if (!summary) {
      return done({ tone: "unknown", text: "Coverage unknown", detail: "The store did not report per-mailbox coverage with this result." });
    }
    var unknown = (summary.unknown || []).filter(Boolean);
    var stale = (summary.stale || []).filter(function (id) { return id && unknown.indexOf(id) < 0; });
    var total = Number(summary.mailboxes || 0);
    var current = Number(summary.current || 0);
    var at = clock(summary.watermark);
    if (!total) return done({ tone: "unknown", text: "No mailboxes in scope", detail: "This query covers no mailbox, so it can prove nothing." });
    if (unknown.length) {
      return done({
        tone: "unknown",
        text: "Unknown for " + labelList(unknown, label),
        detail: "These mailboxes never reported a completed sync, so mail could exist that this list cannot show."
      });
    }
    if (stale.length) {
      return done({
        tone: "stale",
        text: "Stale: " + stale.length + " mailbox" + (stale.length === 1 ? "" : "es") + " behind, oldest " + (at || "an unreported time"),
        detail: labelList(stale, label) + " — behind by more than 15 minutes or not active."
      });
    }
    // A summary that does not add up is itself unknown coverage: nothing is
    // reported behind, yet fewer mailboxes are current than are in scope.
    if (current !== total) {
      return done({
        tone: "unknown",
        text: "Coverage does not add up: " + current + " of " + plural(total, "mailbox") + " current, none reported behind",
        detail: "The store reported no stale or unreported mailbox and still counted fewer current mailboxes than are in scope, so this coverage cannot be trusted."
      });
    }
    return done({
      tone: "current",
      text: "Current through " + (at || "an unreported time") + " (" + current + " of " + total + " mailbox" + (total === 1 ? "" : "es") + ")",
      detail: "Every mailbox in scope reported a completed sync at or after that time."
    });
  }

  // What an empty list is allowed to claim. The service's negativeEvidence.kind
  // is derived from staleness and the watermark alone, so this cross-checks it
  // against the summary it arrived with AND against per-mailbox history: an
  // in-scope mailbox whose backfill is "partial" or "none" means older mail may
  // simply never have been imported, and absence there proves nothing.
  function emptyStateText(coverage, options) {
    var clock = (options || {}).clock || clockTime;
    var evidence = (coverage && coverage.negativeEvidence) || null;
    var kind = evidence && evidence.kind;
    var summary = (coverage && coverage.summary) || null;
    var impaired = summary ? ((summary.stale || []).filter(Boolean).length + (summary.unknown || []).filter(Boolean).length) : 0;
    var scoped = scopedMailboxes(coverage);
    var incomplete = incompleteHistory(coverage);
    var historyDetail = false;
    var reason = "";
    if (kind === "none_through_watermark") {
      if (!summary) reason = "the store did not report coverage alongside this claim";
      else if (impaired) reason = "the store reported " + plural(impaired, "mailbox") + " behind or unreported alongside this claim";
      else if (!scoped.length) reason = "the store did not report per-mailbox history with this result";
      else if (incomplete.length) { reason = "historical import is not complete for " + plural(incomplete.length, "mailbox"); historyDetail = true; }
    } else if (kind === "unknown") {
      reason = (evidence && evidence.reason) || "coverage was not confirmed";
    } else {
      reason = "coverage was not reported";
    }
    if (!reason) {
      var at = clock(evidence.watermark);
      return {
        tone: "confirmed",
        headline: at ? "No conversations match, through " + at : "No conversations match",
        detail: "Every mailbox in scope is synced through that time and has its full history imported, so this empty result is a confirmed absence."
      };
    }
    return {
      tone: "unknown",
      headline: "Result unknown: " + reason,
      detail: historyDetail
        ? "The synced-through time bounds only the newest edge of coverage; older mail that has never been imported would not appear here."
        : "A mailbox in scope is behind or unreported, so matching mail may exist that this list cannot show."
    };
  }

  // The store reports some warnings as machine codes (lib/search.mjs pushes
  // "date_invalid:before"). Those are for consumers, not for a person reading a
  // search box, so the known ones are translated and anything else is passed
  // through unchanged rather than hidden.
  function warningText(message) {
    var machine = /^([a-z_]+):([a-z_]+)$/.exec(message);
    if (machine && machine[1] === "date_invalid") return machine[2] + ": needs a calendar date like 2026-09-01, so that filter was ignored";
    return message;
  }

  // What the search box quietly did with the query it was given.
  function searchNotice(parsed) {
    var notes = [];
    var unsupported = (parsed && parsed.unsupported) || [];
    var warnings = (parsed && parsed.warnings) || [];
    for (var i = 0; i < unsupported.length; i++) {
      var entry = unsupported[i];
      var field = typeof entry === "string" ? entry : (entry && entry.field);
      if (!field) continue;
      var as = (entry && typeof entry === "object" && entry.searchedAs) || "text";
      notes.push(String(field).replace(/:$/, "") + ": is not supported; searched as " + as);
    }
    for (var j = 0; j < warnings.length; j++) {
      var warning = warnings[j];
      var message = typeof warning === "string" ? warning : (warning && warning.message);
      if (message) notes.push(warningText(String(message)));
    }
    return notes.join(" · ");
  }

  // Which mailbox copy a row's badge should name: the one the user scoped to
  // when this conversation has a copy there, else the first retained copy.
  function badgeCopy(mailboxIds, scopedId) {
    var ids = (mailboxIds || []).filter(Boolean);
    if (scopedId && ids.indexOf(scopedId) >= 0) return scopedId;
    return ids[0] || "";
  }

  function viewTitle(folder, mailboxAddress) {
    var route = normalizeRoute({ folder: folder });
    var name = FOLDER_LABELS[route.folder] || route.folder;
    return mailboxAddress ? name + " · " + mailboxAddress : name;
  }

  var api = {
    FOLDERS: FOLDERS,
    FOLDER_LABELS: FOLDER_LABELS,
    DEFAULT_FOLDER: DEFAULT_FOLDER,
    EMPTY_ROUTE: EMPTY_ROUTE,
    normalizeRoute: normalizeRoute,
    serializeRoute: serializeRoute,
    parseRoute: parseRoute,
    sameRoute: sameRoute,
    clockTime: clockTime,
    coverageSummary: coverageSummary,
    emptyStateText: emptyStateText,
    searchNotice: searchNotice,
    scopedMailboxes: scopedMailboxes,
    incompleteHistory: incompleteHistory,
    badgeCopy: badgeCopy,
    viewTitle: viewTitle
  };

  // Registered on the global in BOTH runtimes: the browser reads
  // window.MasterInboxRoute, and a Node test that require()s this file gets the
  // same object on globalThis, so page code and tests share one route contract.
  if (typeof window !== "undefined") window.MasterInboxRoute = api;
  if (typeof globalThis !== "undefined") globalThis.MasterInboxRoute = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
