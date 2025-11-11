// neighbor-activity/index.js

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs").promises;
const { adminBuddyUrl, maxPages, delayMs } = require("./config");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// href에서 blogId 추출
function extractBlogId(href) {
  if (!href) return null;

  const direct = href.match(/blog\.naver\.com\/([a-zA-Z0-9._-]+)/);
  if (direct) return direct[1];

  const param = href.match(/blogId=([a-zA-Z0-9._-]+)/);
  if (param) return param[1];

  return null;
}

/**
 * 1단계: Buddy 관리 페이지에서 1페이지, 2페이지... 순서대로 호출하며 이웃 blogId 수집
 * - 브라우저에서 주소가 안 바뀌더라도, 백엔드가 currentPage 파라미터를 쓰는 경우를 활용
 * - 각 페이지에서 새로 나오는 blogId가 없으면 조기 종료
 */
async function fetchNeighborBlogIds() {
  const cookie = process.env.NAVER_COOKIE;
  if (!cookie) {
    throw new Error("NAVER_COOKIE secret이 설정되어 있지 않습니다.");
  }

  const allIds = new Set();
  let lastSize = 0;

  for (let page = 1; page <= maxPages; page++) {
    const url =
      page === 1
        ? adminBuddyUrl
        : `${adminBuddyUrl}&currentPage=${page}`;

    console.log(`📥 Fetch neighbors from page ${page}: ${url}`);

    try {
      const res = await axios.get(url, {
        headers: {
          "User-Agent": UA,
          Cookie: cookie
        }
      });

      const $ = cheerio.load(res.data);

      // 이 페이지에서 blogId 추출
      $("a[href*='blog.naver.com']").each((_, el) => {
        const href = $(el).attr("href");
        const id = extractBlogId(href);
        if (id) allIds.add(id);
      });

      // 혹시 스크립트/데이터에 박혀있는 blogId도 한번 더 긁기
      const html = $.html();
      const regex = /blogId[=:]"?([a-zA-Z0-9._-]+)"?/g;
      let m;
      while ((m = regex.exec(html)) !== null) {
        if (m[1]) allIds.add(m[1]);
      }

      console.log(`   👥 Collected so far: ${allIds.size}`);

      // 이 페이지에서 새로운 이웃이 하나도 안 늘어났으면 더 볼 필요 없음
      if (allIds.size === lastSize) {
        console.log(
          `   ⛔ No new neighbors on page ${page}. Stop scanning pages.`
        );
        break;
      }
      lastSize = allIds.size;

      // 혹시 페이지에 이웃 리스트가 거의 없으면(마지막 페이지 느낌) 멈춰도 됨
      // (선택: 원하면 지워도 됨)
      await sleep(500);
    } catch (e) {
      console.warn(`   ⚠️ Failed to load page ${page}: ${e.message}`);
      break; // 에러 나면 과감히 종료
    }
  }

  console.log(`👥 Total unique neighbor blogs found: ${allIds.size}`);
  return Array.from(allIds);
}

/**
 * 활동정보 텍스트에서
 *  - 블로그 이웃 N명
 *  - 글 스크랩 N회
 * 를 추출
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
 * 문서 안에서 "활동정보" 블록 찾아서 텍스트 추출
 */
function extractActivityInfo($) {
  let activityText = "";

  // "활동정보"라는 문구가 있는 블럭 우선
  $("div, section, ul, li, span, p").each((_, el) => {
    const txt = $(el).text();
    if (txt.includes("활동정보")) {
      activityText += " " + txt;
    }
  });

  // 그래도 없으면 전체 텍스트에서 시도
  if (!activityText.trim()) {
    activityText = $("body").text();
  }

  return parseActivityInfoText(activityText);
}

/**
 * 인플루언서 여부: in.naver.com 링크나 뱃지/클래스로 추정
 */
function detectInfluencer($, html) {
  if ($("a[href*='in.naver.com']").length > 0) return "Y";
  if (html.includes("in.naver.com") && html.includes("인플루언서")) return "Y";
  if ($("[class*='influencer'], [src*='influencer']").length > 0) return "Y";
  return "N";
}

/**
 * 2단계: 각 블로그 페이지에서 활동정보 긁기
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

    // 메인에서 활동정보 찾기
    let act = extractActivityInfo($);
    neighborCount = act.neighborCount || "";
    scrapCount = act.scrapCount || "";
    isInfluencer = detectInfluencer($, html);

    // 일부 스킨: mainFrame 안에 활동정보가 있을 수 있음
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
      // 👉 이 값이 "다른 사람들이 그 사람 글을 스크랩해 간 총 횟수"
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
 * 3단계: 전체 실행 & CSV 저장
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
