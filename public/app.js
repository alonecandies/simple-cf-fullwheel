"use strict";
(() => {
  // src/client/app.ts
  function query(selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing guestbook element: ${selector}`);
    return element;
  }
  function errorMessage(error, fallback) {
    return error instanceof Error ? error.message : fallback;
  }
  var form = query("#message-form");
  var nameInput = query("#name");
  var messageInput = query("#message");
  var imageInput = query("#image");
  var characterCount = query("#character-count");
  var messageCount = query("#message-count");
  var visitorCount = query("#visitor-count");
  var notesList = query("#notes-list");
  var statusLine = query("#form-status");
  var submitButton = query("#submit-button");
  var searchPanel = query("#search-panel");
  var searchForm = query("#search-form");
  var searchQueryInput = query("#search-query");
  var searchProvider = query("#search-provider");
  var searchStatus = query("#search-status");
  var searchResults = query("#search-results");
  var turnstileToken = "";
  var turnstileWidgetId;
  var zarazPurposeId = null;
  function setStatus(message = "", state = "") {
    statusLine.textContent = message;
    statusLine.dataset.state = state;
  }
  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(void 0, {
      month: "short",
      day: "numeric",
      year: date.getFullYear() === (/* @__PURE__ */ new Date()).getFullYear() ? void 0 : "numeric"
    }).format(date);
  }
  function createNote(entry, index) {
    const item = document.createElement("li");
    item.className = "note-row";
    const initial = document.createElement("span");
    initial.className = `note-initial note-initial-${index % 4}`;
    initial.setAttribute("aria-hidden", "true");
    initial.textContent = Array.from(entry.name.trim())[0]?.toUpperCase() || "?";
    const body = document.createElement("div");
    body.className = "note-body";
    const byline = document.createElement("div");
    byline.className = "note-byline";
    const author = document.createElement("span");
    author.className = "note-author";
    author.textContent = entry.name;
    const date = document.createElement("time");
    date.className = "note-date";
    date.dateTime = entry.created_at;
    date.textContent = formatDate(entry.created_at);
    const text = document.createElement("p");
    text.className = "note-message";
    text.textContent = entry.message;
    byline.append(author, date);
    body.append(byline, text);
    if (entry.imageUrl === `/media/${entry.id}`) {
      const image = document.createElement("img");
      image.className = "note-photo";
      image.src = entry.imageUrl;
      image.alt = `Photo shared by ${entry.name}`;
      image.loading = "lazy";
      image.decoding = "async";
      body.append(image);
    }
    if (entry.shareCardUrl === `/share-cards/${entry.id}`) {
      const actions = document.createElement("div");
      actions.className = "note-actions";
      const download = document.createElement("a");
      download.className = "share-card-link";
      download.href = entry.shareCardUrl;
      download.download = `passing-place-${entry.id}.jpg`;
      download.textContent = "Download share card";
      actions.append(download);
      body.append(actions);
    }
    item.append(initial, body);
    return item;
  }
  function renderMessages(messages, total) {
    messageCount.textContent = String(total);
    if (messages.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty-note";
      const title = document.createElement("h3");
      title.textContent = "The first note is yours.";
      const hint = document.createElement("p");
      hint.textContent = "Add a hello and start the guestbook.";
      empty.append(title, hint);
      notesList.replaceChildren(empty);
      return;
    }
    notesList.replaceChildren(
      ...messages.map((entry, index) => createNote(entry, index))
    );
  }
  async function loadMessages() {
    const loading = document.createElement("li");
    loading.className = "loading-note";
    loading.textContent = "Finding the latest notes\u2026";
    notesList.replaceChildren(loading);
    try {
      const response = await fetch("/api/messages", {
        headers: { Accept: "application/json" }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load the guestbook.");
      renderMessages(data.messages, data.total);
    } catch (error) {
      notesList.replaceChildren();
      const item = document.createElement("li");
      item.className = "empty-note";
      const title = document.createElement("h3");
      title.textContent = "The guestbook did not load.";
      const hint = document.createElement("p");
      hint.textContent = "Check your connection and try again.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry-button";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => void loadMessages());
      item.append(title, hint, retry);
      notesList.append(item);
      messageCount.textContent = "\u2014";
      console.error("Could not load the guestbook", error);
    }
  }
  function setupTurnstile(siteKey) {
    if (!siteKey) return;
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (!window.turnstile) return;
      turnstileWidgetId = window.turnstile.render("#turnstile", {
        sitekey: siteKey,
        action: "guestbook-post",
        callback: (token) => {
          turnstileToken = token;
          setStatus();
        },
        "expired-callback": () => {
          turnstileToken = "";
        },
        "error-callback": () => {
          turnstileToken = "";
          setStatus("The human check could not load. Refresh and try again.", "error");
        }
      });
    };
    script.onerror = () => {
      setStatus("The human check could not load. Refresh and try again.", "error");
    };
    document.head.append(script);
  }
  function connectPresence() {
    if (typeof WebSocket === "undefined") return;
    let retryCount = 0;
    const connect = () => {
      const socketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${socketProtocol}//${window.location.host}/api/presence`);
      let reconnectScheduled = false;
      let stableConnectionTimer = 0;
      socket.addEventListener("open", () => {
        stableConnectionTimer = window.setTimeout(() => {
          retryCount = 0;
        }, 3e4);
        void loadMessages();
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        try {
          const update = JSON.parse(event.data);
          if (typeof update.count === "number" && Number.isFinite(update.count)) {
            visitorCount.textContent = `${Math.max(0, Math.floor(update.count))} here now`;
          }
          if (update.type === "new-note" || update.type === "share-card-ready") {
            void loadMessages();
          }
        } catch (error) {
          console.warn("Received an invalid live guestbook update", error);
        }
      });
      const scheduleReconnect = () => {
        if (reconnectScheduled) return;
        reconnectScheduled = true;
        window.clearTimeout(stableConnectionTimer);
        visitorCount.textContent = "Live count reconnecting";
        const delay = Math.min(3e4, 1e3 * 2 ** retryCount);
        retryCount = Math.min(retryCount + 1, 5);
        window.setTimeout(connect, delay);
      };
      socket.addEventListener("close", scheduleReconnect);
      socket.addEventListener("error", () => socket.close());
    };
    connect();
  }
  function setupWebAnalytics(token) {
    if (!token || document.querySelector("[data-passing-place-analytics]")) return;
    const script = document.createElement("script");
    script.src = "https://static.cloudflareinsights.com/beacon.min.js";
    script.defer = true;
    script.setAttribute("data-cf-beacon", JSON.stringify({ token }));
    script.dataset.passingPlaceAnalytics = "true";
    document.head.append(script);
  }
  function setupSearch(config) {
    const modes = [];
    if (config.aiSearchEnabled) modes.push({ value: "ai-search", label: "AI Search" });
    if (config.vectorSearchEnabled) modes.push({ value: "vectorize", label: "Similar notes" });
    if (modes.length === 0) return;
    searchProvider.replaceChildren(
      ...modes.map(({ value, label }) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      })
    );
    searchProvider.hidden = modes.length < 2;
    searchForm.classList.toggle("single", modes.length < 2);
    searchPanel.hidden = false;
  }
  function trackZaraz(eventName, properties = {}) {
    const zaraz = window.zaraz;
    if (!zarazPurposeId || !zaraz?.track || zaraz.consent?.APIReady !== true) return;
    try {
      if (zaraz.consent.get(zarazPurposeId) !== true) return;
      zaraz.track(eventName, properties);
    } catch {
    }
  }
  async function waitForModeration(id) {
    const startedAt = Date.now();
    const timeoutMs = 3e4;
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      try {
        const response = await fetch("/api/messages/status/" + encodeURIComponent(id), {
          headers: { Accept: "application/json" }
        });
        if (!response.ok) break;
        const data = await response.json();
        if (data.status === "approved") {
          setStatus("Your note is now in the guestbook.", "success");
          await loadMessages();
          return;
        }
        if (data.status === "rejected") {
          setStatus(
            "The safety check held that note. Please write a different note and try again.",
            "error"
          );
          return;
        }
        if (data.status === "unavailable") {
          setStatus(
            "The safety check is temporarily unavailable. Please try your note again later.",
            "error"
          );
          return;
        }
      } catch (error) {
        console.error("Could not check the moderation status", error);
        break;
      }
    }
    setStatus(
      "Your note is still being checked. It will appear here if approved; refresh in a moment.",
      "success"
    );
  }
  messageInput.addEventListener("input", () => {
    characterCount.textContent = `${messageInput.value.length} / 240`;
  });
  imageInput.addEventListener("change", () => {
    const image = imageInput.files?.[0];
    if (!image) return;
    if (!/^(image\/jpeg|image\/png|image\/webp)$/.test(image.type)) {
      imageInput.value = "";
      setStatus("Choose a JPG, PNG, or WebP photo.", "error");
      return;
    }
    if (image.size > 512 * 1024) {
      imageInput.value = "";
      setStatus("Your photo must be 512 KB or smaller.", "error");
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus();
    const name = nameInput.value.trim();
    const message = messageInput.value.trim();
    if (name.length < 2 || message.length < 3) {
      setStatus("Add your name and a note of at least 3 characters.", "error");
      return;
    }
    submitButton.disabled = true;
    submitButton.querySelector("span:first-child").textContent = "Sending for review\u2026";
    try {
      const payload = new FormData(form);
      payload.set("turnstileToken", turnstileToken);
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { Accept: "application/json" },
        body: payload
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Your note could not be added.");
      }
      form.reset();
      characterCount.textContent = "0 / 240";
      turnstileToken = "";
      setStatus("Your note was received. A quick safety check is running.", "success");
      trackZaraz("guestbook_note_submitted", { channel: "web" });
      void waitForModeration(data.id);
    } catch (error) {
      setStatus(errorMessage(error, "Your note could not be added. Try again."), "error");
    } finally {
      turnstileToken = "";
      if (turnstileWidgetId !== void 0 && window.turnstile) {
        window.turnstile.reset(turnstileWidgetId);
      }
      submitButton.disabled = false;
      submitButton.querySelector("span:first-child").textContent = "Add my note";
    }
  });
  searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const queryText = searchQueryInput.value.trim();
    if (queryText.length < 2 || queryText.length > 120) {
      searchStatus.textContent = "Search text must be 2 to 120 characters.";
      searchStatus.dataset.state = "error";
      return;
    }
    searchStatus.textContent = "Searching approved notes\u2026";
    searchStatus.dataset.state = "";
    searchResults.replaceChildren();
    const provider = searchProvider.value;
    const button = searchForm.querySelector("button[type='submit']");
    if (button) button.disabled = true;
    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query: queryText, provider })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Search is unavailable.");
      if (data.messages.length === 0) {
        searchStatus.textContent = "No matching approved notes yet.";
      } else {
        searchStatus.textContent = `${data.messages.length} matching note${data.messages.length === 1 ? "" : "s"}.`;
        searchResults.replaceChildren(
          ...data.messages.map((entry, index) => createNote(entry, index))
        );
      }
      trackZaraz("guestbook_search_completed", {
        provider,
        result_count: data.messages.length
      });
    } catch (error) {
      searchStatus.textContent = errorMessage(error, "Search is unavailable. Try again soon.");
      searchStatus.dataset.state = "error";
    } finally {
      if (button) button.disabled = false;
    }
  });
  async function start() {
    connectPresence();
    const configRequest = fetch("/api/config", {
      headers: { Accept: "application/json" }
    }).then((response) => response.json()).then((config) => {
      setupTurnstile(config.turnstileSiteKey);
      setupWebAnalytics(config.webAnalyticsToken);
      setupSearch(config);
      zarazPurposeId = config.zarazEnabled ? config.zarazConsentPurposeId : null;
    }).catch((error) => console.error("Could not load guestbook settings", error));
    await Promise.all([configRequest, loadMessages()]);
  }
  void start();
})();
