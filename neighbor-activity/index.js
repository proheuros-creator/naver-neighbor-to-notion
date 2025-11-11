const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs").promises;
const { adminBuddyUrl, delayMs } = require("./config");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function extractBlogId(href) {
  if (!href) return null;
  const direct = href.match(/blog\.naver\.com\/([a-zA-Z0-9._-]+)/);
  if (direct) return direct[1];
  const param = href.match(/blogId=([a-zA-Z0-9._-]+)/);
  if (param) return param[1];
  return null;
}

async function fetchNeighborBlogIds() {
  const cookie = process.env.NAVER_COOKIE;
  if (!cookie) {
    throw new Error("NAVER_COOKIE secret이 설정되어 있지 않습니다.");
  }

  console.log(`📥 Fetch neighbor list from admin: ${adminBuddyUrl}`);

  const res = await axios.get(adminBuddyUrl, {
    headers: {
      "User-Agent": UA,
      Cookie: cookie
    }
  });

  const $ = cheerio.load(res.data);
  const ids = new Set();

  $("a[href*='blog.naver.com']").each((_, el) => {
    const href = $(el).attr("href");
    const id = extractBlogId(href);
    if (id) ids.add(id);
  });

  const bodyHtml = $.html();
  const regex = /blogId[=:]"?([a-zA-Z0-9._-]+)"?/g;
  let m;
  while ((m = regex.exec(bodyHtml)) !== null) {
    if (m[1]) ids.add(m[1]);
  }

  const list = Array.from(ids);
  console.log(`👥 Found ${list.length} neighbor blogs.`);
  return list;
}

function parseActivityInfoText(text) {
  const t = text.replace(/\s+/g, " ");
  let neighborCount = "";
  let scrapCount = "";

  const nMatch = t.match(/블로그\s*이웃\s*([\d,]+)\s*명/);
  if (nMatch) neighborCount = nMatch[1].replace(/,/g, "");

  const sMatch = t.match(/글\s*스크랩\s*([\d,]+)\s*회/);
  if (sMatch) scrapCount = sMatch[1].replace(/,/g, "");

  return { neighborCount, scrapCount };
}

function extractActivityInfo($) {
  let activityText = "";

  $("div, section, ul, li, span, p").each((_, el) => {
    const txt = $(el).text();
    if (txt.includes("활동정보")) {
      activityText += " " + txt;
    }
  });

  if (!activityText.trim()) {
    activityText = $("body").text();
  }

  return parseActivityInfoText(activityText);
}

function detectInfluencer($, html) {
  if ($("a[href*='in.naver.com']").length > 0) return "Y";
  if (html.includes("in.naver.com") && html.includes("인플루언서")) return "Y";
  if ($("[class*='influencer'], [src*='influencer']").length > 0) return "Y";
  return "N";
}

async function fetchBlogInfo(blogId) {
  const blogUrl = `https://blog.naver.com/${blogId}`;
  console.log(`🔍 Scan blog: ${blogId} (${blogUrl})`);

  let neighborCount = "";
  let scrapCount = "";
  let isInfluencer = "";

  try {
    const res = await axios.get(blogUrl, {
      maxRedirects: 5,
      headers: { "User-Agent": UA }
    });

    let html = res.data;
    let $ = cheerio.load(html);

    let act = extractActivityInfo($);
    neighborCount = act.neighborCount || "";
    scrapCount = act.scrapCount || "";
    isInfluencer = detectInfluencer($, html);

    if ((!neighborCount || !scrapCount) && $("iframe#mainFrame").length > 0) {
      const iframeSrc = $("iframe#mainFrame").attr("src");
      if (iframeSrc) {
        const frameUrl = iframeSrc.startsWith("http")
          ? iframeSrc
          : `https://blog.naver.com${iframeSrc}`;

        try {
          const frameRes = await axios.get(frameUrl, {
            headers: { "User-Agent": UA }
          });
          const $$ = cheerio.load(frameRes.data);
          const act2 = extractActivityInfo($$);

          if (!neighborCount && act2.neighborCount)
            neighborCount = act2.neighborCount;
          if (!scrapCount && act2.scrapCount)
            scrapCount = act2.scrapCount;
        } catch (e) {
          console.warn(`   ⚠️ iframe scan failed for ${blogId}: ${e.message}`);
        }
      }
    }

    return {
      blogId,
      blogUrl,
      neighborCount,
      scrapScrapedByOthers: scrapCount,
      isInfluencer
    };
  } catch (e) {
    console.warn(`   ⚠️ Failed to scan ${blogId}: ${e.message}`);
    return {
      blogId,
      blogUrl,
      neighborCount: "",
      scrapScrapedByOthers: "",
      isInfluencer: ""
    };
  }
}

async function main() {
  try {
    const blogIds = await fetchNeighborBlogIds();

    const results = [];
    for (const id of blogIds) {
      const info = await fetchBlogInfo(id);
      results.push(info);
      await sleep(delayMs);
    }

    const header =
      "blogId,blogUrl,neighborCount,scrapScrapedByOthers,isInfluencer\n";

    const lines = results.map((r) =>
      [
        r.blogId,
        r.blogUrl,
        r.neighborCount,
        r.scrapScrapedByOthers,
        r.isInfluencer
      ]
        .map((v) => (v != null ? String(v).replace(/"/g, '""') : ""))
        .map((v) => `"${v}"`)
        .join(",")
    );

    await fs.writeFile("neighbor-activity-result.csv", header + lines.join("\n"), "utf8");
    console.log("✅ Done. neighbor-activity-result.csv 생성 완료");
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  }
}

main();
