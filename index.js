/**
 * index.js
 * ───────────────────────────────────────────────
 * 🧭 네이버 블로그 이웃새글 → Notion 자동 스크랩 메인 실행 파일
 *
 * 핵심:
 *  - 네이버 응답의 blogId 필드는 신뢰하지 않는다.
 *  - 실제 글 URL (https://blog.naver.com/{blogId}/{postId}) 에서
 *    blogId, postId 를 추출하여 사용한다.
 *  - UniqueID = {blogId}_{postId}
 *  - CSV(neighbor-followings-result.csv)의 blogId, groupNames로
 *    Group(multi-select)을 설정한다.
 */

import "dotenv/config";
import fetch from "node-fetch";
import { upsertPost } from "./notion.js";

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { fileURLToPath } from "url";

// ───────────────────────────────────────────────
// 🔧 환경 변수 & 경로
// ───────────────────────────────────────────────

const NAVER_COOKIE = process.env.NAVER_COOKIE;
const API_TEMPLATE = process.env.NAVER_NEIGHBOR_API_URL;
const MAX_PAGE = Number(process.env.MAX_PAGE || 150);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSV_PATH =
  process.env.NEIGHBOR_CSV_PATH ||
  path.resolve(__dirname, "neighbor-followings-result.csv");

if (!NAVER_COOKIE) {
  console.error("❌ NAVER_COOKIE 가 설정되어 있지 않습니다.");
  process.exit(1);
}

if (!API_TEMPLATE) {
  console.error("❌ NAVER_NEIGHBOR_API_URL 이 설정되어 있지 않습니다.");
  process.exit(1);
}

// ───────────────────────────────────────────────
// 🧩 URL → blogId, postId 추출
// ───────────────────────────────────────────────

/**
 * https://blog.naver.com/{blogId}/{postId}
 * 에서 blogId, postId 추출
 */
function extractBlogInfoFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(
    /blog\.naver\.com\/([^/?\s]+)\/(\d+)/i
  );
  if (!m) return null;

  return {
    blogId: m[1],
    postId: m[2],
  };
}

// ───────────────────────────────────────────────
// 📂 CSV → blogId / groupNames 매핑
// ───────────────────────────────────────────────

/**
 * neighbor-followings-result.csv:
 *   - blogId
 *   - groupNames ("A" 또는 "A,B,C")
 *
 * map[blogId] = { groupNames }
 */
function loadBlogMetaMap() {
  if (!fs.existsSync(CSV_PATH)) {
    console.warn(
      `⚠️ neighbor-followings-result.csv 를 찾을 수 없습니다: ${CSV_PATH}`
    );
    return {};
  }

  try {
    const csv = fs.readFileSync(CSV_PATH, "utf8");
    const records = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const map = {};

    for (const row of records) {
      const raw =
        row.blogId ||
        row.blogID ||
        row.BlogID ||
        row["Blog ID"] ||
        row.id ||
        row.ID;

      if (!raw) continue;

      const blogId = String(raw).trim();
      if (!blogId) continue;

      const groupNamesRaw =
        row.groupNames ||
        row.groupName ||
        row.GroupNames ||
        row.GroupName ||
        "";

      map[blogId] = {
        groupNames: groupNamesRaw
          ? String(groupNamesRaw).trim()
          : "",
      };
    }

    console.log(
      `✅ CSV 로드 완료: ${Object.keys(map).length}개 blogId 매핑`
    );
    return map;
  } catch (err) {
    console.error("❌ CSV 파싱 실패:", err.message);
    return {};
  }
}

const BLOG_META_MAP = loadBlogMetaMap();

// ───────────────────────────────────────────────
// 🏗 page/currentPage 기반 URL 생성
// ───────────────────────────────────────────────

function buildPageUrl(page) {
  try {
    const u = new URL(API_TEMPLATE);

    if (u.searchParams.has("page")) {
      u.searchParams.set("page", String(page));
    } else if (u.searchParams.has("currentPage")) {
      u.searchParams.set("currentPage", String(page));
    } else {
      u.searchParams.append("page", String(page));
    }

    // groupId 는 템플릿 값 유지 (예: 0 = 전체)
    return u.toString();
  } catch {
    let url = API_TEMPLATE;

    if (url.includes("page=")) {
      url = url.replace(/(page=)\d+/, `$1${page}`);
    } else if (url.includes("currentPage=")) {
      url = url.replace(/(currentPage=)\d+/, `$1${page}`);
    } else {
      const sep = url.includes("?") ? "&" : "?";
      url = `${url}${sep}page=${page}`;
    }

    return url;
  }
}

// ───────────────────────────────────────────────
// 🧹 네이버 응답 전처리
// ───────────────────────────────────────────────

function stripNaverPrefix(raw) {
  return raw.replace(/^\)\]\}',?\s*/, "");
}

function cleanedPreview(raw) {
  const cleaned = stripNaverPrefix(raw || "");
  return cleaned.slice(0, 120) + (cleaned.length > 120 ? "..." : "");
}

// ───────────────────────────────────────────────
// 📥 페이지 단위 스크랩
// ───────────────────────────────────────────────

async function fetchPagePosts(page) {
  const url = buildPageUrl(page);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (NaverNeighborScraper)",
      Cookie: NAVER_COOKIE,
      Accept: "application/json, text/plain, */*",
      Referer: "https://section.blog.naver.com/BlogHome.naver",
    },
  });

  if (!res.ok) {
    console.error(
      `❌ ${page}페이지 API 요청 실패:`,
      res.status,
      res.statusText
    );
    return { posts: [] };
  }

  const raw = await res.text();

  let data;
  try {
    const cleaned = stripNaverPrefix(raw);
    data = JSON.parse(cleaned);
  } catch (e) {
    console.error(`❌ ${page}페이지 JSON 파싱 실패:`, e.message);
    console.error(cleanedPreview(raw));
    return { posts: [] };
  }

  const result = data.result || data;
  const list =
    result.buddyPostList ||
    result.postList ||
    result.list ||
    result.items ||
    [];

  let missingMetaCount = 0;

  let posts = list
    .map((item) => {
      const title = item.title || item.postTitle || "";
      if (!title) return null;

      // 1) 우선 URL을 결정
      const urlFromItem =
        item.url ||
        item.postUrl ||
        item.blogPostUrl ||
        "";

      const logNo =
        item.logNo || item.postId || item.articleId || null;

      let link = urlFromItem;

      // URL이 없고 blogId/logNo 조합이 있으면 만들어 준다
      const candidateBlogId =
        item.blogId || item.blogNo || item.bloggerId || "";

      if ((!link || !link.includes("blog.naver.com")) &&
          candidateBlogId &&
          logNo) {
        link = `https://blog.naver.com/${candidateBlogId}/${logNo}`;
      }

      // 2) URL에서 blogId/postId 추출 (가장 신뢰하는 소스)
      const extracted = extractBlogInfoFromUrl(link);

      let blogId = extracted?.blogId || "";
      let postId = extracted?.postId || "";

      // 3) URL에서 못 뽑았으면, 마지막 수단으로 응답 필드 사용
      if (!blogId && candidateBlogId) {
        blogId = String(candidateBlogId).trim();
      }
      if (!postId && logNo) {
        postId = String(logNo).trim();
      }

      // blogId/postId 둘 다 못 구하면 스킵
      if (!blogId || !postId || !link) {
        console.warn(
          `⚠️ blogId/postId 추출 실패, 스킵: ${title} (url=${link})`
        );
        return null;
      }

      // 4) CSV 매핑: URL에서 얻은 blogId 기준
      const meta = BLOG_META_MAP[blogId] || null;
      const groupName = meta?.groupNames || "";

      if (!meta || !meta.groupNames) {
        missingMetaCount++;
      }

      const nickname =
        item.nickName ||
        item.bloggerName ||
        item.userName ||
        "";

      const pubdate =
        item.addDate ||
        item.postDate ||
        item.writeDate ||
        item.regDate ||
        item.createdAt ||
        null;

      const description =
        item.briefContents ||
        item.summary ||
        item.contentsPreview ||
        item.previewText ||
        "";

      return {
        title,
        link,
        nickname,
        pubdate,
        description,
        blogId,
        postId,
        groupName, // 👉 notion.js에서 Group(multi-select) 셋팅용
      };
    })
    .filter(Boolean);

  if (missingMetaCount > 0) {
    console.log(
      `ℹ️ ${page}페이지: CSV에 groupNames 없는 blogId ${missingMetaCount}건 (Group 미지정)`
    );
  }

  // 네이버 응답: 최신 → 과거
  // Notion에는 과거 → 최신 순으로 넣기 위해 reverse
  posts = posts.reverse();

  return { posts };
}

// ───────────────────────────────────────────────
// 🚀 메인 실행
// ───────────────────────────────────────────────

async function main() {
  console.log(
    "🚀 전체 이웃 새글 → Notion 스크랩 시작 (URL 기반 blogId/postId + CSV groupNames 매핑)"
  );

  let total = 0;

  for (let page = MAX_PAGE; page >= 1; page--) {
    const { posts } = await fetchPagePosts(page);
    console.log(`📥 ${page}페이지 글 수: ${posts.length}`);
    total += posts.length;

    for (const post of posts) {
      try {
        await upsertPost(post);
      } catch (err) {
        console.error("❌ Notion 저장 오류:", err.message);
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`🎉 스크랩 완료 (총 ${total}건 처리 시도)`);
}

main().catch((err) => {
  console.error("❌ 스크립트 전체 오류:", err);
  process.exit(1);
});
