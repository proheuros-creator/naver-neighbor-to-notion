// neighbor-activity/index.js

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs").promises;
const { baseId, startPage, endPage, delayMs } = require("./config");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractBlogId(href) {
  if (!href) return null;
  const m = href.match(/^https?:\/\/blog\.naver\.com\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// 1. BuddyListManage 1~N페이지에서 "내가 추가한 이웃" blogId 수집
async function fetchNeighborBlogIds() {
  const cookie = process.env.NAVER_COOKIE;
  if (!cookie) throw new Error("NAVER_COOKIE secret이 없습니다.");

  const ids = new Set();

  for (let page = startPage; page <= endPage; page++) {
    const url = `https://admin.blog.naver.com/BuddyListManage.naver?blogId=${baseId}&buddyPage=${page}`;
    console.log(`📥 Fetch neighbors page ${page}: ${url}`);

    try {
      const res = await axios.get(url, {
        headers: {
          "User-Agent": UA,
          Cookie: cookie
        }
      });

      const $ = cheerio.load(res.data);
      const before = ids.size;

      // 이 페이지의 이웃 블로그 링크들
      $("a[href*='blog.naver.com/']").each((_, el) => {
        const href = $(el).attr("href");
        const id = extractBlogId(href);
        if (id) ids.add(id);
      });

      console.log(
        `   👥 Collected: ${ids.size} (page ${page}, +${
          ids.size - before
        })`
      );

      // 새로 추가된 게 없으면 뒤 페이지는 없다고 보고 종료
      if (ids.size === before) {
        console.log("   ⛔ No new neighbors on this page. Stop.");
        break;
      }

      await sleep(300);
    } catch (e) {
      console.warn(
        `   ⚠️ Failed to load neighbors page ${page}: ${e.message}`
      );
      break;
    }
  }

  console.log(`👥 Total unique neighbor blogs found: ${ids.size}`);
  return [...ids];
}

// 2. 활동정보 텍스트에서 이웃 수 / 글 스크랩 수 추출
function parseActivityInfoText(text) {
  const t = text.replace(/\s+/g, " ");
  let neighborCount = "";
  let scrapCount = "";

  // 1차: "블로그 이웃 123명"
  let m = t.match(/블로그\s*이웃\s*([\d,]+)\s*명/);
  if (m) neighborCount = m[1].replace(/,/g, "");

  // 2차: "이웃 123명"
  if (!neighborCount) {
    m = t.match(/[^가-힣A-Za-z]이웃\s*([\d,]+)\s*명/);
    if (m) neighborCount = m[1].replace(/,/g, "");
  }

  // 글 스크랩: "글 스크랩 45회" 우선
  m = t.match(/글\s*스크랩\s*([\d,]+)\s*회/);
  if (m) scrapCount = m[1].replace(/,/g, "");

  // 혹시 "스크랩 45회"만 있는 경우
  if (!scrapCount) {
    m = t.match(/스크랩\s*([\d,]+)\s*회/);
    if (m) scrapCount = m[1].replace(/,/g, "");
  }

  return { neighborCount, scrapCount };
}

// 활동정보 영역 탐색 (없으면 전체 텍스트에서 추출 시도)
function extractActivityInfo($) {
  let txt = "";

  // 활동정보 영역 위주로 긁기
  $(
    "div, section, ul, li, span, p"
  ).each((_, el) => {
    const t = $(el).text();
    if (
      t.includes("활동정보") ||
      t.includes("블로그 이웃") ||
      t.includes("글 스크랩")
    ) {
      txt += " " + t;
    }
  });

  // 그래도 없으면 전체 텍스트에서 시도 (fallback)
  if (!txt.trim()) {
    txt = $("body").text();
  }

  return parseActivityInfoText(txt);
}

// 인플루언서 여부 추정
// 인플루언서 여부 추정 (블로그 HTML + in.naver.com 프로필 둘 다 검사)
async function detectInfluencer(blogId, $, html) {
  // 1차: 블로그 페이지 안에서 바로 확인
  if ($("a[href*='in.naver.com']").length > 0) return "Y";
  if (
    html.includes("in.naver.com") &&
    (html.includes("인플루언서") || html.toLowerCase().includes("influencer"))
  ) {
    return "Y";
  }
  if ($("[class*='influencer'], [src*='influencer']").length > 0) return "Y";

  // 2차: in.naver.com/{blogId} 직접 조회
  const inUrl = `https://in.naver.com/${blogId}`;
  try {
    const res = await axios.get(inUrl, {
      maxRedirects: 0,
      validateStatus: (s) => s === 200 || (s >= 300 && s < 400),
      headers: { "User-Agent": UA }
    });

    // 3xx 리다이렉트 되어도 인플루언서 프로필이면 HTML/헤더에 흔적이 남아있을 수 있음
    const body = typeof res.data === "string" ? res.data : "";
    const text = (body || "").toString();

    if (
      res.status === 200 &&
      (text.includes("인플루언서") ||
        text.toLowerCase().includes("influencer") ||
        text.includes("in.naver.com"))
    ) {
      return "Y";
    }
  } catch (e) {
    // 404/에러면 인플루언서 아님으로 간주
  }

  return "N";
}

// 3. 각 블로그의 활동정보 수집
async function fetchBlogInfo(blogId) {
  const blogUrl = `https://blog.naver.com/${blogId}`;
  console.log(`🔍 Scan blog: ${blogId} (${blogUrl})`);

  try {
    const res = await axios.get(blogUrl, {
      maxRedirects: 5,
      headers: { "User-Agent": UA }
    });

    const html = res.data;
    let $ = cheerio.load(html);

    // 활동정보 추출 (여긴 네가 이미 교체해둔 parse/extract 버전 사용)
    let { neighborCount, scrapCount } = extractActivityInfo($);

    // 인플루언서 판별 (블로그 + in.naver.com/{blogId})
    let isInfluencer = await detectInfluencer(blogId, $, html);

    // mainFrame 안에 활동정보가 있는 스킨 대응
    if ((!neighborCount || !scrapCount) && $("iframe#mainFrame").length > 0) {
      const src = $("iframe#mainFrame").attr("src");
      if (src) {
        const frameUrl = src.startsWith("http")
          ? src
          : `https://blog.naver.com${src}`;
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

// 4. 전체 실행 & CSV 저장
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
