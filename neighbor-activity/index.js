const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs").promises;
const { adminBuddyUrl, maxPages, delayMs } = require("./config");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * 순수 블로그 주소 형태만 blogId로 인정:
 *  - https://blog.naver.com/{id}
 *  - {id}는 영문/숫자/_/- 만 ('.' 들어가면 네이버 기능 URL일 확률 높아서 제외)
 */
function extractPureBlogIdFromHref(href) {
  if (!href) return null;

  // 절대 URL 패턴
  const m1 = href.match(/^https?:\/\/blog\.naver\.com\/([A-Za-z0-9_-]+)$/);
  if (m1) return m1[1];

  // 쿼리형 (?blogId=xxx)도 허용하되, id에 '.' 있으면 버림
  const m2 = href.match(/blogId=([A-Za-z0-9_-]+)/);
  if (m2) return m2[1];

  return null;
}

/**
 * AdminMain 에서 실제 이웃 목록 페이지(BuddyListManage)를 찾아서
 * 그걸 기준으로 페이지네이션을 돌린다.
 */
async function fetchNeighborBlogIds() {
  const cookie = process.env.NAVER_COOKIE;
  if (!cookie) {
    throw new Error("NAVER_COOKIE secret이 설정되어 있지 않습니다.");
  }

  console.log(`📥 Load admin main: ${adminBuddyUrl}`);
  const mainRes = await axios.get(adminBuddyUrl, {
    headers: {
      "User-Agent": UA,
      Cookie: cookie
    }
  });
  const $main = cheerio.load(mainRes.data);

  // 1) AdminMain 안에서 BuddyListManage.naver 링크 또는 iframe/src 찾기
  let firstBuddyUrl = null;

  const pickBuddyUrl = (raw, base) => {
    if (!raw) return;
    if (!raw.includes("BuddyListManage.naver")) return;
    const abs = raw.startsWith("http")
      ? raw
      : new URL(raw, base).toString();
    if (!firstBuddyUrl) firstBuddyUrl = abs;
  };

  $main("a[href*='BuddyListManage.naver']").each((_, el) => {
    pickBuddyUrl($main(el).attr("href"), adminBuddyUrl);
  });

  $main("iframe, frame, script").each((_, el) => {
    const src = $main(el).attr("src");
    if (src && src.includes("BuddyListManage.naver")) {
      pickBuddyUrl(src, adminBuddyUrl);
    }
  });

  if (!firstBuddyUrl) {
    throw new Error(
      "BuddyListManage.naver URL을 AdminMain 페이지에서 찾지 못했습니다. HTML 구조가 바뀐 것 같습니다."
    );
  }

  console.log(`🔗 Detected buddy list base: ${firstBuddyUrl}`);

  // 2) BuddyListManage.naver 페이지들을 BFS로 순회
  const toVisit = new Set([firstBuddyUrl]);
  const visited = new Set();
  const blogIds = new Set();
  let pageCount = 0;

  while (toVisit.size > 0) {
    const url = [...toVisit][0];
    toVisit.delete(url);
    if (visited.has(url)) continue;
    visited.add(url);

    pageCount++;
    if (pageCount > maxPages) {
      console.log("⛔ maxPages 도달, 페이지 순회 중단");
      break;
    }

    console.log(`📄 Buddy page ${pageCount}: ${url}`);

    let res;
    try {
      res = await axios.get(url, {
        headers: {
          "User-Agent": UA,
          Cookie: cookie
        }
      });
    } catch (e) {
      console.warn(`   ⚠️ Failed to load buddy page: ${e.message}`);
      continue;
    }

    const $ = cheerio.load(res.data);

    // 이 페이지에서 "실제 블로그" 링크만 추출
    $("a[href*='blog.naver.com']").each((_, el) => {
      const href = $(el).attr("href");
      const id = extractPureBlogIdFromHref(href);
      if (id) {
        blogIds.add(id);
      }
    });

    console.log(`   👥 Collected so far: ${blogIds.size}`);

    // 페이지네이션 안의 다음 BuddyListManage 링크들 수집
    $("a[href*='BuddyListManage.naver']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const abs = href.startsWith("http")
        ? href
        : new URL(href, url).toString();
      if (!visited.has(abs)) {
        toVisit.add(abs);
      }
    });

    await sleep(300);
  }

  console.log(`👥 Total unique neighbor blogs found: ${blogIds.size}`);
  return Array.from(blogIds);
}

/**
 * 활동정보 텍스트에서 숫자 추출
 */
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

/**
 * 문서에서 "활동정보" 블럭 찾기
 */
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

/**
 * 인플루언서 여부 추정
 */
function detectInfluencer($, html) {
  if ($("a[href*='in.naver.com']").length > 0) return "Y";
  if (html.includes("in.naver.com") && html.includes("인플루언서")) return "Y";
  if ($("[class*='influencer'], [src*='influencer']").length > 0) return "Y";
  return "N";
}

/**
 * 각 블로그 활동정보 크롤링
 */
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

    // 일부 스킨(mainFrame 안)
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
          console.warn(
            `   ⚠️ iframe scan failed for ${blogId}: ${e.message}`
          );
        }
      }
    }

    return {
      blogId,
      blogUrl,
      neighborCount,
      // 👉 다른 사람들이 그 사람 글을 스크랩한 횟수
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

/**
 * 전체 실행 & CSV 저장
 */
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

    await fs.writeFile(
      "neighbor-activity-result.csv",
      header + lines.join("\n"),
      "utf8"
    );
    console.log("✅ Done. neighbor-activity-result.csv 생성 완료");
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  }
}

main();
