const { app, BrowserWindow } = require("electron");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {
  getHeaders,
  shouldAllowScrapingRequest,
  getBypassCheck,
  isMegaplayNetwork,
} = require("./proxyHeaders");
const { run, queryAll, queryOne } = require("./db");

let isQuitting = false;
let activeBypasses = {};
let bypassQueue = [];
let bypassBusy = false;

app.on("before-quit", () => {
  isQuitting = true;
});

// Create Scrapping Window
function createScrapperWindow() {
  global.ScrapperWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      partition: "persist:scrapper",
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  global.ScrapperWindow.webContents.session.on(
    "will-download",
    (event, item) => {
      event.preventDefault();
      if (!app.isPackaged) {
        console.log(`[ScrapperWindow] Blocked download of: ${item.getURL()}`);
      }
    },
  );

  const defaultUA = global.ScrapperWindow.webContents.userAgent;
  global.userAgent = defaultUA
    .replace(/Electron\/[\d\.]+ /g, "")
    .replace(/strawverse\/[\d\.]+ /g, "");
  global.ScrapperWindow.webContents.userAgent = global.userAgent;

  global.ScrapperWindow.webContents.session.webRequest.onBeforeRequest(
    { urls: ["*://*/*"] },
    (details, callback) => {
      if (global.IsBypassingCloudflare) {
        callback({ cancel: false });
        return;
      }
      if (
        !details.url.startsWith("http://") &&
        !details.url.startsWith("https://")
      ) {
        callback({ cancel: false });
        return;
      }
      if (details.url.includes(".m3u8") && !details.url.includes("ping.gif")) {
        global.LastM3u8 = details.url;
      }
      if (shouldAllowScrapingRequest(details.url, details.resourceType)) {
        callback({ cancel: false });
      } else {
        callback({ cancel: true });
      }
    },
  );

  global.ScrapperWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ["*://*/*"] },
    (details, callback) => {
      if (details.requestHeaders["User-Agent"]) {
        details.requestHeaders["User-Agent"] = details.requestHeaders[
          "User-Agent"
        ]
          .replace(/Electron\/[\d\.]+ /g, "")
          .replace(/strawverse\/[\d\.]+ /g, "");
      }
      if (details.requestHeaders["sec-ch-ua"]) {
        details.requestHeaders["sec-ch-ua"] = details.requestHeaders[
          "sec-ch-ua"
        ]
          .replace(/"Electron";v="[\d\.]+",?/g, "")
          .replace(/,?\s*"Electron";v="[\d\.]+"/g, "");
      }

      const { Referer: referer, "User-Agent": userAgent } = getHeaders(
        details.url,
      );
      if (referer) details.requestHeaders["Referer"] = referer;
      if (userAgent) details.requestHeaders["User-Agent"] = userAgent;
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  global.ScrapperWindow.webContents.on(
    "did-fail-load",
    (event, errorCode, errorDescription, validatedURL) => {
      console.error(
        `Failed to load ${validatedURL}: ${errorCode} - ${errorDescription}`,
      );
    },
  );

  global.ScrapperWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      global.ScrapperWindow.hide();
    }
  });

  global.ScrapperWindow.on("closed", () => {
    global.ScrapperWindow = null;
  });
}

async function processBypassQueue() {
  if (bypassBusy || bypassQueue.length === 0) return;
  bypassBusy = true;
  const { runBypass, resolve, reject } = bypassQueue.shift();
  try {
    const result = await runBypass();
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    bypassBusy = false;
    processBypassQueue();
  }
}

function queueBypass(runBypass) {
  return new Promise((resolve, reject) => {
    bypassQueue.push({ runBypass, resolve, reject });
    processBypassQueue();
  });
}

global.cloudflarebypass = async (
  targetUrl,
  successCheckFn,
  force = false,
  targetCookieDomain = null,
) => {
  if (!global.ScrapperWindow) {
    throw new Error("Global ScrapperWindow is not initialized");
  }

  const win = global.ScrapperWindow;
  const domain =
    targetCookieDomain || new URL(targetUrl).hostname.replace("www.", "");
  const dbKey = `${domain}-cf_clearance`;

  // 1. Check database for valid cookie expiration date
  try {
    const row = queryOne("SELECT expirationDate FROM cookie WHERE id = ?", [
      dbKey,
    ]);
    if (
      row &&
      row.expirationDate &&
      row.expirationDate > Date.now() &&
      !force
    ) {
      return;
    }
  } catch (e) {
    console.error("Failed to check cookie expiration in DB:", e);
  }

  if (activeBypasses[domain]) {
    return activeBypasses[domain];
  }

  activeBypasses[domain] = queueBypass(async () => {
    global.IsBypassingCloudflare = true;

    try {
      run("DELETE FROM cookie WHERE id = ?", [dbKey]);
      await win.webContents.session.cookies.remove(targetUrl, "cf_clearance");
    } catch (e) {
      console.error("[Bypass] Failed to clear cookie before bypass:", e);
    }

    try {
      let loadError = null;
      try {
        await win.loadURL(targetUrl);
      } catch (err) {
        loadError = err;
      }

      let passed = false;
      for (let i = 0; i < 60; i++) {
        const sessionCookies = await win.webContents.session.cookies.get({});
        const hasClearanceForDomain = sessionCookies.some(
          (c) =>
            c.name === "cf_clearance" &&
            c.domain.includes(domain.replace("www.", "")),
        );

        if (hasClearanceForDomain) {
          passed = true;
          break;
        }

        const title = win.webContents.getTitle() || "";
        const lowerTitle = title.toLowerCase();

        let isChallenge =
          lowerTitle.includes("just a moment") ||
          lowerTitle.includes("cloudflare") ||
          lowerTitle.includes("captcha");

        let html = "";
        if (!isChallenge || i % 3 === 0) {
          html = await win.webContents
            .executeJavaScript("document.documentElement.outerHTML")
            .catch(() => "");
          const lowerHtml = html.toLowerCase();
          if (
            lowerHtml.includes("cloudflare") ||
            lowerHtml.includes("captcha") ||
            lowerHtml.includes("just a moment")
          ) {
            isChallenge = true;
          }
        }

        if (
          successCheckFn(title, html) &&
          (!force || hasClearanceForDomain || i > 5)
        ) {
          passed = true;
          break;
        } else if (isChallenge) {
          if (!global.ScrapperWindow.isVisible()) win.show();
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (!passed) {
        win.hide();
        throw (
          loadError ||
          new Error(`Timeout waiting for Cloudflare captcha on ${targetUrl}`)
        );
      }

      win.hide();

      // Retrieve cookies from session and find all cf_clearance to store their expiration
      const cookies = await win.webContents.session.cookies.get({});
      for (const c of cookies) {
        if (c.name === "cf_clearance") {
          const cookieDomainName = c.domain.startsWith(".")
            ? c.domain.slice(1)
            : c.domain;
          const expiry = c.expirationDate
            ? c.expirationDate * 1000
            : Date.now() + 1000 * 60 * 10;

          const key = `${cookieDomainName}-cf_clearance`;
          try {
            run(
              `INSERT OR REPLACE INTO cookie (id, value, name, domain, url, path, secure, httpOnly, expirationDate) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                key,
                c.value,
                "cf_clearance",
                cookieDomainName,
                "",
                "",
                "",
                "",
                expiry,
              ],
            );
          } catch (dbErr) {
            console.error("Failed to save cf_clearance to database:", dbErr);
          }
        }
      }
    } finally {
      global.IsBypassingCloudflare = false;
    }
  });

  try {
    await activeBypasses[domain];
  } finally {
    delete activeBypasses[domain];
  }
};

async function ExitScrapperWindow() {
  if (global.ScrapperWindow && !global.ScrapperWindow.isDestroyed()) {
    isQuitting = true;
    global.ScrapperWindow.close();
    global.ScrapperWindow = null;
  }
}

global.axios = axios.create();
global.axios.interceptors.request.use(
  async (config) => {
    const url = config.url;
    if (url) {
      const isStreamOrSub =
        url.includes("/stream/") ||
        url.includes("getSources") ||
        url.includes("/subtitles/") ||
        url.includes(".vtt") ||
        url.includes(".m3u8") ||
        url.match(/\/anime\/[a-f0-9]{32}\/[a-f0-9]{32}\//);

      if (
        !isStreamOrSub &&
        (url.includes("megaplay") ||
          url.includes("mewstream") ||
          url.includes("orbitra") ||
          url.includes("lostproject"))
      ) {
        global.lastIframeUrl = url;
      }
    }

    const { cookieRequired, ...headers } = getHeaders(config.url);
    config.headers = { ...config.headers, ...headers };
    if (cookieRequired && !headers.Cookie) {
      const bypass = getBypassCheck(config.url);
      if (bypass && global.cloudflarebypass) {
        try {
          let reqDomain = null;
          try {
            reqDomain = new URL(config.url).hostname.replace("www.", "");
          } catch (e) {}
          await global.cloudflarebypass(
            bypass.baseUrl,
            bypass.check,
            false,
            reqDomain,
          );
          const { cookieRequired: _, ...newHeaders } = getHeaders(config.url);
          config.headers = { ...config.headers, ...newHeaders };
        } catch (err) {
          console.error("Failed pre-emptive Cloudflare bypass:", err.message);
        }
      }
    }
    return config;
  },
  (error) => Promise.reject(error),
);

global.axios.interceptors.response.use(
  (response) => {
    const data = response.data;
    if (
      data &&
      data.errors &&
      data.errors.some((e) => e.message === "NEED_CAPTCHA") &&
      !response.config._retry
    ) {
      response.config._retry = true;
      const bypass = getBypassCheck(response.config.url);
      if (bypass && global.cloudflarebypass) {
        let reqDomain = null;
        try {
          reqDomain = new URL(response.config.url).hostname.replace("www.", "");
        } catch (e) {}
        return global
          .cloudflarebypass(bypass.baseUrl, bypass.check, true, reqDomain)
          .then(() => {
            const { cookieRequired, ...newHeaders } = getHeaders(
              response.config.url,
            );
            response.config.headers = {
              ...response.config.headers,
              ...newHeaders,
            };
            return global.axios(response.config);
          });
      }
    }
    return response;
  },
  async (error) => {
    const { config, response } = error;
    if (
      response &&
      (response.status === 403 || response.status === 503) &&
      config &&
      !config._retry
    ) {
      config._retry = true;
      const bypass = getBypassCheck(config.url);
      if (bypass && global.cloudflarebypass) {
        console.log(
          `Cloudflare challenge detected (status: ${response.status}) for ${config.url}. Retrying with bypass...`,
        );
        try {
          let reqDomain = null;
          try {
            reqDomain = new URL(config.url).hostname.replace("www.", "");
          } catch (e) {}
          await global.cloudflarebypass(
            bypass.baseUrl,
            bypass.check,
            true,
            reqDomain,
          );
          const { cookieRequired, ...newHeaders } = getHeaders(config.url);
          config.headers = {
            ...config.headers,
            ...newHeaders,
          };
          return global.axios(config);
        } catch (bypassErr) {
          return Promise.reject(bypassErr);
        }
      }
    }
    return Promise.reject(error);
  },
);

module.exports = {
  createScrapperWindow,
  ExitScrapperWindow,
};
