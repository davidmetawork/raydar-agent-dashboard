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

  // The status pill. tone drives the colour; text is the whole claim; detail is
  // the hover, which names the mailboxes behind a summary number.
  function coverageSummary(coverage, options) {
    var settings = options || {};
    var label = settings.label || function (id) { return id; };
    var clock = settings.clock || clockTime;
    var summary = coverage && coverage.summary;
    if (!summary) {
      return { tone: "unknown", text: "Coverage unknown", detail: "The store did not report per-mailbox coverage with this result." };
    }
    var unknown = (summary.unknown || []).filter(Boolean);
    var stale = (summary.stale || []).filter(function (id) { return id && unknown.indexOf(id) < 0; });
    var total = Number(summary.mailboxes || 0);
    var current = Number(summary.current || 0);
    var at = clock(summary.watermark);
    if (!total) return { tone: "unknown", text: "No mailboxes in scope", detail: "This query covers no mailbox, so it can prove nothing." };
    if (unknown.length) {
      return {
        tone: "unknown",
        text: "Unknown for " + labelList(unknown, label),
        detail: "These mailboxes never reported a completed sync, so mail could exist that this list cannot show."
      };
    }
    if (stale.length) {
      return {
        tone: "stale",
        text: "Stale: " + stale.length + " mailbox" + (stale.length === 1 ? "" : "es") + " behind, oldest " + (at || "an unreported time"),
        detail: labelList(stale, label) + " — behind by more than 15 minutes or not active."
      };
    }
    return {
      tone: "current",
      text: "Current through " + (at || "an unreported time") + " (" + current + " of " + total + " mailbox" + (total === 1 ? "" : "es") + ")",
      detail: "Every mailbox in scope reported a completed sync at or after that time."
    };
  }

  // What an empty list is allowed to claim.
  function emptyStateText(coverage, options) {
    var clock = (options || {}).clock || clockTime;
    var evidence = (coverage && coverage.negativeEvidence) || null;
    var kind = evidence && evidence.kind;
    if (kind === "none_through_watermark") {
      var at = clock(evidence.watermark);
      return {
        tone: "confirmed",
        headline: at ? "No conversations match, through " + at : "No conversations match",
        detail: "Every mailbox in scope is synced through that time, so this empty result is a confirmed absence."
      };
    }
    if (kind === "unknown") {
      return {
        tone: "unknown",
        headline: "Result unknown: " + (evidence.reason || "coverage was not confirmed"),
        detail: "A mailbox in scope is behind or unreported, so matching mail may exist that this list cannot show."
      };
    }
    return {
      tone: "unknown",
      headline: "Result unknown: coverage was not reported",
      detail: "Without per-mailbox coverage an empty list cannot be told apart from a sync failure."
    };
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
      if (message) notes.push(String(message));
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
    badgeCopy: badgeCopy,
    viewTitle: viewTitle
  };

  if (typeof window !== "undefined") window.MasterInboxRoute = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
