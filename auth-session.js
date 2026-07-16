(function () {
  const channel = "BroadcastChannel" in window ? new BroadcastChannel("raydar-auth") : null;
  if (channel) channel.addEventListener("message", function (event) {
    if (event.data === "signed-in" || event.data === "signed-out") location.reload();
  });

  async function request(path, options) {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: { accept: "application/json", ...(options && options.headers) },
    });
    const body = await response.json().catch(function () { return {}; });
    if (!response.ok || !body.ok) {
      const error = new Error(body.error || "Authentication failed");
      error.code = body.error;
      error.status = response.status;
      throw error;
    }
    return body;
  }

  window.RaydarAuth = Object.freeze({
    session: async function () {
      try { return await request("/api/auth/session"); }
      catch (error) {
        if (error.status === 401 || error.status === 503) return null;
        throw error;
      }
    },
    signIn: async function (credential) {
      const session = await request("/api/auth/google", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential: credential }),
      });
      if (channel) channel.postMessage("signed-in");
      return session;
    },
    signOut: async function () {
      const result = await request("/api/auth/logout", { method: "POST" });
      if (channel) channel.postMessage("signed-out");
      return result;
    },
  });
})();
