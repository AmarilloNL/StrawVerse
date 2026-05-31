const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

let isBusy = false;
let isQuitting = false;
const queue = [];
const COOKIE_FILE = path.join(app.getPath("userData"), "cookies.json");

app.on("before-quit", () => {
  isQuitting = true;
});

// Loading helpers

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
  
  const defaultUA = global.ScrapperWindow.webContents.userAgent;
  global.ScrapperWindow.webContents.userAgent = defaultUA.replace(/Electron\/[\d\.]+ /g, '').replace(/strawverse\/[\d\.]+ /g, '');

  global.ScrapperWindow.webContents.session.webRequest.onBeforeRequest(
    { urls: ["*://*/*"] },
    (details, callback) => {
      if (global.IsBypassingCloudflare) {
        callback({ cancel: false });
        return;
      }
      if (!details.url.startsWith("http://") && !details.url.startsWith("https://")) {
        callback({ cancel: false });
        return;
      }
      if (details.url.includes(".m3u8") && !details.url.includes("ping.gif")) {
        global.LastM3u8 = details.url;
      }
      if (
        details.resourceType === "mainFrame" ||
        details.url.includes("ddos-guard") ||
        details.url.includes("apdoesnthavelogotheysaidapistooplaintheysaid") ||
        details.url.includes("api/fsearch") ||
        details.url.includes("megaplay") ||
        details.url.includes("jquery") ||
        details.url.includes("jsdelivr") ||
        details.url.includes(".m3u8") ||
        details.url.includes("megacloud") ||
        details.url.includes("rabbitstream") ||
        details.url.includes("jwpcdn") ||
        details.url.includes("cloudflare") ||
        details.url.includes("cdn-cgi") ||
        details.url.includes("allmanga") ||
        details.url.includes("allanime") ||
        details.url.includes("youtube-anime") ||
        details.url.includes("ytimgf")
      ) {
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
        details.requestHeaders["User-Agent"] = details.requestHeaders["User-Agent"].replace(/Electron\/[\d\.]+ /g, '').replace(/strawverse\/[\d\.]+ /g, '');
      }
      if (details.requestHeaders["sec-ch-ua"]) {
        details.requestHeaders["sec-ch-ua"] = details.requestHeaders["sec-ch-ua"].replace(/"Electron";v="[\d\.]+",?/g, '').replace(/,?\s*"Electron";v="[\d\.]+"/g, '');
      }
      if (details.url.includes("megaplay")) {
        details.requestHeaders["Referer"] = "https://anikototv.to/";
      }
      callback({ requestHeaders: details.requestHeaders });
    }
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

  loadCookies();

  global.ScrapperWindow.webContents.session.cookies.on(
    "changed",
    (event, cookie, cause, removed) => {
      saveCookies();
    },
  );
}

let cookieSaveTimeout = null;

// Save Cookies to disk
async function saveCookies() {
  if (!global.ScrapperWindow) return;
  
  if (cookieSaveTimeout) {
    clearTimeout(cookieSaveTimeout);
  }

  cookieSaveTimeout = setTimeout(async () => {
    try {
      if (!global.ScrapperWindow) return;
      const cookies = await global.ScrapperWindow.webContents.session.cookies.get({});
      fs.writeFile(COOKIE_FILE, JSON.stringify(cookies, null, 2), (err) => {
        if (err) console.error("Failed to save cookies", err);
      });
    } catch (err) {
      // ignore errors
    }
  }, 2000);
}

// Load Cookies from disk
async function loadCookies() {
  if (!global.ScrapperWindow) return;
  if (!fs.existsSync(COOKIE_FILE)) return;

  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
    for (const cookie of cookies) {
      const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
      const url = `${cookie.secure ? "https" : "http"}://${domain}${cookie.path}`;
      await global.ScrapperWindow.webContents.session.cookies.set({
        url: url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.expirationDate,
      });
    }
  } catch (err) {
    console.error("Failed to load cookies:", err);
  }
}

// Public scrapeURL function, queues requests
global.scrapeURL = async (url, type = null) => {
  return new Promise((resolve, reject) => {
    queue.push({ url, type, resolve, reject });
    processQueue();
  });
};

async function processQueue() {
  if (isBusy || queue.length === 0 || !global.ScrapperWindow) return;

  const { url, resolve, reject } = queue.shift();
  isBusy = true;

  try {
    if (typeof url === "object") {
      await global.ScrapperWindow.loadURL(url.url);

      const result = await global.ScrapperWindow.webContents.executeJavaScript(`
          (async () => {
            try {
              const res = await fetch("${url.url}${url.path}", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(${JSON.stringify(url.body)})
              });
              return await res.text();
            } catch (err) {
              return "FETCH_ERROR: " + err.message;
            }
          })()
        `);

      if (result.startsWith("FETCH_ERROR:")) {
        throw result;
      } else {
        try {
          const json = JSON.parse(result);
          resolve(json);
        } catch {
          throw result;
        }
      }
    } else {
      await global.ScrapperWindow.loadURL(url);

      await new Promise((resolve) => {
        global.ScrapperWindow.webContents.once("did-stop-loading", resolve);
      });

      await new Promise((r) => setTimeout(r, 1500));
    }

    const bodyText = await global.ScrapperWindow.webContents.executeJavaScript(
      "document.body.innerText",
    );

    try {
      const json = JSON.parse(bodyText);
      resolve(json);
    } catch {
      const html = await global.ScrapperWindow.webContents.executeJavaScript(
        "document.documentElement.outerHTML",
      );
      resolve(html);
    }
  } catch (err) {
    if (err.message.includes("ERR_ABORTED")) {
      // INGORED
    } else {
      reject(err);
    }
  } finally {
    isBusy = false;
    processQueue();
  }
}

async function ExitScrapperWindow() {
  if (global.ScrapperWindow && !global.ScrapperWindow.isDestroyed()) {
    await saveCookies();
    isQuitting = true;
    global.ScrapperWindow.close();
    global.ScrapperWindow = null;
  }
}

module.exports = {
  createScrapperWindow,
  ExitScrapperWindow,
};
