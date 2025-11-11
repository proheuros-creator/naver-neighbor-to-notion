// neighbor-activity/index.js
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs").promises;
const { baseId, startPage, endPage, delayMs } = require("./config");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractBlogId(href) {
  const m = href.match(/^https?:\/\/blog\.naver\.com\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

async function fetchNeighborBlogIds() {
  const cookie = process.env.NAVER_COOKIE;
  if (!cookie) throw new Error("NAVER_COOKIE가 없습니다.");

  const blogIds = new Set();

  for (let p = startPage; p <= endPage; p++) {
    const url = `https://admin.blog.naver.com/BuddyListManage.naver?blogId=${baseId}&buddyPage=${p}`;
    console.log(`📥 Fetch page ${p}: ${url}`);

    const res = await axios.get(url, {
      headers: { "User-Agent": UA, Cookie: cookie },
    });
    const $ = cheerio.load(res.data);

    $("a[href*='blog.naver.com/']").each((_, el) => {
      const id = extractBlogId($(el).attr("href"));
      if (id) blogIds.add(id);
    });

    console.log(`   👥 Collected so far: ${blogIds.size}`);
    await sleep(delayMs);
  }

  console.log(`👥 Total neighbor blogs found: ${blogIds.size}`);
  return [...blogIds];
}

function parseActivityInfoText(text) {
  const t = text.replace(/\s+/g, " ");
  const n = t.match(/블로그\s*이웃\s*([\d,]+)\s*명/);
  const s = t.match(/글\s*스크랩\s*([\d,]+)\s*회/);
  return {
    neighborCount: n ? n[1].replace(/,/g, "") : "",
    scrapCount: s ? s[1].replace(/,/g, "") : "",
  };
}

function detectInfluencer($, html) {
  if ($("a[href*='in.naver.com']").length) return "Y";
  if (html.includes("in.naver.com")) return "Y";
  return "N";
}

async function fetchBlogInfo(blogId) {
  const url = `https://blog.naver.com/${blogId}`;
  console.log(`🔍 Scan blog: ${blogId}`);

  try {
    const res = await axios.get(url, { headers: { "User-Agent": UA } });
    const html = res.data;
    const $ = cheerio.load(html);
    const { neighborCount, scrapCount } = parseActivityInfoText($("body").text());
    const isInf = detectInfluencer($, html);

    return { blogId, url, neighborCount, scrapCount, isInf };
  } catch {
    return { blogId, url, neighborCount: "", scrapCount: "", isInf: "" };
  }
}

async function main() {
  const ids = await fetchNeighborBlogIds();
  const results = [];

  for (const id of ids) {
    results.push(await fetchBlogInfo(id));
    await sleep(delayMs);
  }

  const csv =
    "blogId,blogUrl,neighborCount,scrapScrapedByOthers,isInfluencer\n" +
    results
      .map(
        (r) =>
          `"${r.blogId}","${r.url}","${r.neighborCount}","${r.scrapCount}","${r.isInf}"`
      )
      .join("\n");

  await fs.writeFile("neighbor-activity-result.csv", csv, "utf8");
  console.log("✅ Done. neighbor-activity-result.csv 생성 완료");
}

main();
