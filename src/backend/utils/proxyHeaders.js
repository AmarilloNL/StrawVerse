const { queryOne } = require("./db");

const ALLOWED_SCRAPING_SUBSTRINGS = [
  "ddos-guard",
  "apdoesnthavelogotheysaidapistooplaintheysaid",
  "api/fsearch",
  "megaplay",
  "mewstream",
  "orbitra",
  "lostproject",
  "sparkora",
  ".buzz",
  ".click",
  ".club",
  "jquery",
  "jsdelivr",
  ".m3u8",
  "megacloud",
  "rabbitstream",
  "jwpcdn",
  "cloudflare",
  "cdn-cgi",
  "allmanga",
  "allanime",
  "youtube-anime",
  "ytimgf",
  "kwik",
];

function isMegaplayNetwork(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (
      hostname.endsWith(".buzz") ||
      hostname.endsWith(".click") ||
      hostname.endsWith(".club")
    ) {
      return true;
    }
    if (
      hostname.includes("megaplay") ||
      hostname.includes("mewstream") ||
      hostname.includes("orbitra") ||
      hostname.includes("lostproject") ||
      hostname.includes("sparkora")
    ) {
      return true;
    }
  } catch (e) {}
  return false;
}

/**
 * Shared utility for resolving stream headers (Referer & User-Agent)
 * dynamically based on target stream URLs.
 */
function getHeaders(url) {
  let referer = "";
  let userAgent =
    global.userAgent ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
  let Cookie = "";
  let cookieDomain = "";
  let cookieRequired = false;

  // kwik - animepahe
  if (url.includes("owocdn.top")) {
    referer = "https://kwik.cx/";
  } else if (url.includes("kwik.cx")) {
    referer = "https://animepahe.pw/";
    cookieDomain = "kwik.cx";
    cookieRequired = true;
  }
  // animepahe
  else if (url.includes("animepahe")) {
    referer = "https://animepahe.pw/";
    cookieDomain = "animepahe.pw";
    cookieRequired = true;
  }
  // weebcentral
  else if (
    url.includes("temp.compsci88.com") ||
    url.startsWith("https://temp.compsci88.com/")
  ) {
    referer = "https://weebcentral.com/";
  }
  // megaplay - anikoto
  else if (url.includes("anikototv.to")) {
    referer = "https://anikototv.to/";
    cookieDomain = "anikototv.to";
    cookieRequired = true;
  } else if (url.includes("megaplay")) {
    const isStreamOrSub =
      url.includes("/stream/") ||
      url.includes("getSources") ||
      url.includes("/subtitles/") ||
      url.includes(".vtt") ||
      url.includes(".m3u8") ||
      url.match(/\/anime\/[a-f0-9]{32}\/[a-f0-9]{32}\//);

    if (isStreamOrSub) {
      referer = "https://megaplay.buzz/";
    } else {
      referer = "https://anikototv.to/";
    }
    cookieDomain = "megaplay.buzz";
    cookieRequired = true;
  } else if (isMegaplayNetwork(url)) {
    referer = "https://megaplay.buzz/";
    try {
      cookieDomain = new URL(url).hostname;
    } catch (e) {
      cookieDomain = "megaplay.buzz";
    }
    cookieRequired = true;
  }
  // all manga
  else if (
    url.includes("allmanga.to") ||
    url.includes("allanime.day") ||
    url.includes("youtube-anime.com")
  ) {
    referer = "https://allmanga.to/";
    cookieDomain = "allmanga.to";
    cookieRequired = true;
  }

  // Query cookies generically for any domain
  if (cookieDomain) {
    try {
      const row = queryOne(
        "SELECT value FROM cookie WHERE id = ? OR id = ? OR id = ? OR (domain LIKE ? AND name = 'cf_clearance') ORDER BY CAST(expirationDate AS REAL) DESC LIMIT 1",
        [
          `${cookieDomain}-cf_clearance`,
          `.${cookieDomain}:cf_clearance`,
          `${cookieDomain}:cf_clearance`,
          `%${cookieDomain}`,
        ],
      );
      if (row && row.value) {
        Cookie = `cf_clearance=${row.value};`;
      }
    } catch (e) {
      // ignore
    }
  }

  const headers = {
    "User-Agent": userAgent,
    cookieRequired: cookieRequired,
  };

  if (referer) {
    headers.Referer = referer;
  }
  if (Cookie) {
    headers.Cookie = Cookie;
  }

  if (
    url.includes("/ajax/") ||
    url.includes("getSources") ||
    url.includes("/stream/")
  ) {
    headers["X-Requested-With"] = "XMLHttpRequest";
  }

  return headers;
}

/**
 * Filter requests within the scraping window to bypass Cloudflare
 * or allow only essential media/API queries.
 */
function shouldAllowScrapingRequest(url, resourceType) {
  if (resourceType === "mainFrame") return true;
  if (isMegaplayNetwork(url)) return true;
  return ALLOWED_SCRAPING_SUBSTRINGS.some((substring) =>
    url.includes(substring),
  );
}

function getBypassCheck(url) {
  if (url.includes("animepahe")) {
    return {
      baseUrl: "https://animepahe.pw",
      check: (title, html) =>
        title.toLowerCase().includes("animepahe") &&
        !title.toLowerCase().includes("just a moment"),
    };
  }

  if (url.includes("kwik.cx")) {
    return {
      baseUrl: "https://kwik.cx",
      check: (title, html) =>
        title.toLowerCase().includes("kwik") &&
        !title.toLowerCase().includes("just a moment"),
    };
  }

  if (
    url.includes("allmanga") ||
    url.includes("allanime") ||
    url.includes("youtube-anime")
  ) {
    return {
      baseUrl: "https://allmanga.to/",
      check: (title, html) =>
        html.includes("__NUXT__") ||
        title.toLowerCase().includes("allmanga") ||
        title.toLowerCase().includes("allanime"),
    };
  }
  if (url.includes("anikoto")) {
    return {
      baseUrl: "https://anikototv.to",
      check: (title, html) =>
        title.toLowerCase().includes("anikoto") &&
        !title.toLowerCase().includes("just a moment"),
    };
  }
  if (isMegaplayNetwork(url)) {
    let targetUrl = url;
    try {
      const u = new URL(url);
      if (u.hostname.includes("megaplay")) {
        targetUrl = global.lastIframeUrl || `${u.origin}/video/1`;
      } else {
        targetUrl = url;
      }
    } catch (e) {
      targetUrl = url;
    }

    return {
      baseUrl: targetUrl,
      check: (title, html) => {
        const lowerTitle = title.toLowerCase();
        const lowerHtml = html.toLowerCase();
        return (
          !lowerTitle.includes("just a moment") &&
          !lowerTitle.includes("blocked") &&
          !lowerHtml.includes("you have been blocked") &&
          (
            lowerHtml.includes("player") ||
            lowerHtml.includes("video") ||
            lowerTitle.includes("player") ||
            lowerTitle.includes("video") ||
            lowerHtml.includes("megaplay") ||
            lowerHtml.includes("mewstream") ||
            lowerHtml.includes("orbitra") ||
            lowerHtml.includes("lostproject") ||
            lowerHtml.includes("sparkora") ||
            lowerTitle.includes("megaplay") ||
            lowerTitle.includes("mewstream") ||
            lowerTitle.includes("orbitra") ||
            lowerTitle.includes("lostproject") ||
            lowerTitle.includes("sparkora")
          )
        );
      },
    };
  }
  return null;
}

module.exports = {
  getHeaders,
  shouldAllowScrapingRequest,
  getBypassCheck,
  isMegaplayNetwork,
};
