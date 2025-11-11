// neighbor-activity/index.js

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs").promises;
const { baseId, maxPages, delayMs } = require("./config");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * BuddyList 페이지에서 이웃 블로그 링크 추출
 * - 형태: https://blog.naver.com/{id}
 */
function extractBlogId(href) {
  if (!href) return null;
  const m = href.match(/^https?:\/\/blog\.naver\.com\/([A-Za-z0-9_-]+)$/);
  return m ? m[1] : null;
}

function collectNeighborsFromHtml(html, idSet) {
  const $ = cheerio.load(html);

  $("a[href*='blog.naver.com/']").each((_, el) => {
    const href = $(el).attr("href");
    const id = extractBlogId(href);
    if (id) idSet.add(id);
  });
}

/**
 * BuddyList HTML 안에서 페이지 이동용 BuddyListManage.naver URL 패턴을 찾는다.
 * - 예: BuddyListManage.naver?blogId=proheuros&currentPage=2
 * - blogId 제외, 숫자값 가진 파라미터명을 pageParam으로 사용
 */
function detectPagingPattern(html, origin) {
  const re = /BuddyListManage\.naver\?([^"' )]+)/g;
  let m;
  let best = null;

  while ((m = re.exec(html)) !== null) {
    try {
      const u = new URL("/BuddyListManage.naver?" + m[1], origin);
      for (const [key, val] of u.searchParams.entries()) {
        if (key === "blogId") continue;
        if (/^\d+$/.test(val)) {
          const num = parseInt(val, 10);
          if (!best || num > best.pageValue) {
            best = { pageParam: key, exampleUrl: u.toString(), pageValue: num };
          }
        }
      }
    } catch {
      // 무시
    }
  }

  return best
    ? { pageParam: best.pageParam, exampleUrl: best.exampleUrl }
    : null;
}

/**
 * 1단계: 내가 추가한 이웃 blogId 전체 수집
 * - 1페이지 BuddyList 요청
 * - 그 HTML에서 실제 사용하는 pageParam 자동 추출
 * - pageParam 기준으로 2..maxPages 순회
 */
async function fetchNeighborBlogIds() {
  const cookie = process.env.NAVER_COOKIE;
  if (!cookie) {
    throw new Error("NAVER_COOKIE secret이 설정되어 있지 않습니다.");
  }

  const origin = "https://admin.blog.naver.com";
  const firstUrl = `${origin}/BuddyListManage.naver?blogId=${baseId}`;

  const ids = new Set();

  // --- page 1 ---
  console.log(`📥 Fetch neighbors page 1: ${firstUrl}`);
  let res1;
  try {
    res1 = await axios.get(firstUrl, {
      headers: { "User-Agent": UA, Cookie: cookie }
    });
  } catch (e) {
    throw new Error(`BuddyList 1페이지 로딩 실패: ${e.message}`);
  }

  const html1 = res1.data;
  collectNeighborsFromHtml(html1, ids);
  console.log(`   👥 Collected: ${ids.size} (page 1)`);

  // --- 페이징 패턴 찾기 ---
  const pattern = detectPagingPattern(html1, origin);

  if (!pattern) {
    console.log(
      "⚠️ 추가 BuddyList 페이지 링크 패턴을 찾지 못했습니다. (1페이지 이웃만 포함)"
    );
    console.log(`👥 Total unique neighbor blogs found: ${ids.size}`);
    return Array.from(ids);
  }

  const { pageParam, exampleUrl } = pattern;
  console.log(`🔍 Detected paging param "${pageParam}" from: ${exampleUrl}`);

  // --- page 2..N ---
  for (let page = 2; page <= maxPages; page++) {
    const u = new URL(exampleUrl);
    u.searchParams.set("blogId", baseId); // 내 블로그로 고정
    u.searchParams.set(pageParam, String(page));
    const pageUrl = u.toString();

    console.log(`📥 Fetch neighbors page ${page}: ${pageUrl}`);

    try {
      const res = await axios.get(pageUrl, {
        headers: { "User-Agent": UA, Cookie: cookie }
      });
      const html = res.data;
      const before = ids.size;

      collectNeighborsFromHtml(html, ids);

      console.log(
        `   👥 Collected: ${ids.size} (page ${page}, +${
          ids.size - before
        })`
      );

      // 새로 추가된 이웃이 없으면 마지막 페이지로 보고 종료
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
  return Array.from(ids);
}

/**
 * 활동정보 텍스트에서
 *  - 블로그 이웃 N명
 *  - 글 스크랩 N회
 * 추출
 * (네가 캡쳐한 "블로그 이웃 8,797명 / 글 스크랩 4,001회" 패턴 대응)
 */
function parseActivityInfoText(text) {
  const t = text.replace(/\s+/g, " ");
  let neighborCount = "";
  let scrapCount = "";

  // "블로그 이웃 8797명"
  let m = t.match(/블로그\s*이웃\s*([\d,]+)\s*명/);
  if (m) neighborCount = m[1].replace(/,/g, "");

  // "이웃 8797명" (혹시 앞에 '블로그' 없을 경우)
  if (!neighborCount) {
    m = t.match(/[^가-힣A-Za-z]이웃\s*([\d,]+)\s*명/);
    if (m) neighborCount = m[1].replace(/,/g, "");
  }

  // "글 스크랩 4001회"
  m = t.match(/글\s*스크랩\s*([\d,]+)\s*회/);
  if (m) scrapCount = m[1].replace(/,/g, "");

  // 혹시 "스크랩 4001회"만 있는 경우
  if (!scrapCount) {
    m = t.match(/스크랩\s*([\d,]+)\s*회/);
    if (m) scrapCount = m[1].replace(/,/g, "");
  }

  return { neighborCount, scrapCount };
}

/**
 * 페이지 내에서 활동정보 영역 찾기
 * - "활동정보", "블로그 이웃", "글 스크랩" 포함 블럭 우선 스캔
 * - 없으면 전체 텍스트 fallback
 */
function extractActivityInfo($) {
  let txt = "";

  $("div, section, ul, li, span, p").each((_, el) => {
    const t = $(el).text();
    if (
      t.includes("활동정보") ||
      t.includes("블로그 이웃") ||
      t.includes("글 스크랩")
    ) {
      txt += " " + t;
    }
  });

  if (!txt.trim()) {
    txt = $("body").text();
  }

  return parseActivityInfoText(txt);
}

/**
 * 인플루언서 여부: 블로그 HTML + in.naver.com/{blogId} 둘 다 검사
 */
async function detectInfluencer(blogId, $, html) {
  // 1차: 블로그 페이지 내 단서
  if ($("a[href*='in.naver.com']").length > 0) return "Y";
  if (
    html.includes("in.naver.com") &&
    (html.includes("인플루언서") ||
      html.toLowerCase().includes("influencer"))
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

    const body =
      typeof res.data === "string" ? res.data : (res.data || "").toString();

    if (
      res.status === 200 &&
      (body.includes("인플루언서") ||
        body.toLowerCase().includes("influencer") ||
        body.includes("in.naver.com"))
    ) {
      return "Y";
    }
  } catch (e) {
    // 404나 에러면 N 처리
  }

  return "N";
}

/**
 * 2단계: 각 블로그의 활동정보 수집
 * - main 페이지 + (필요시) mainFrame 안까지 확인
 */
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

    // 기본 페이지에서 활동정보 탐색
    let { neighborCount, scrapCount } = extractActivityInfo($);

    // 인플루언서 여부
    let isInfluencer = await detectInfluencer(blogId, $, html);

    // 구형 스킨: mainFrame 안에 실제 화면이 있는 경우
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
          console.warn(
            `   ⚠️ iframe(mainFrame) scan failed for ${blogId}: ${e.message}`
          );
        }
      }
    }

    return {
      blogId,
      blogUrl,
      neighborCount,
      // 👉 다른 사람들이 그 블로거 글을 스크랩해 간 횟수
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
        .map((v) =>
          v !== undefined && v !== null ? String(v).replace(/"/g, '""') : ""
        )
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
