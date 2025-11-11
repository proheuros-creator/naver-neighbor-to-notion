/**
 * index.js
 * ───────────────────────────────────────────────
 * 🧭 네이버 블로그 이웃새글 → Notion 자동 스크랩 메인 실행 파일
 *
 * 동작:
 *  1. NAVER_NEIGHBOR_API_URL (예: BlogHome.naver?directoryNo=0&currentPage=1&groupId=0)
 *     템플릿을 사용해 MAX_PAGE → 1 페이지까지 조회
 *     - page 또는 currentPage 파라미터만 변경
 *     - groupId 루프 사용 안 함 (0 = 전체 이웃)
 *  2. neighbor-followings-result.csv (blogId, groupNames)를 읽어
 *     blogId → groupNames 매핑 생성
 *  3. 네이버 응답에서 blogId 기준으로 groupNames 찾아서
 *     post.groupName 으로 notion.js/upsertPost 에 전달
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
// 📂 CSV → blogId / groupNames 매핑
// ───────────────────────────────────────────────

/**
 * neighbor-followings-result.csv:
 *   - blogId
 *   - groupNames (예: "A" 또는 "A,B,C")
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
      const blogIdRaw =
        row.blogId ||
        row.blogID ||
        row.BlogID ||
        row.blog_no ||
        row.blogNo ||
        row.blog_id ||
        row["Blog ID"] ||
        row.id ||
        row.ID;

      if (!blogIdRaw) continue;

      const blogId = String(blogIdRaw).trim();
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
      const blogId =
        item.blogId || item.blogNo || item.bloggerId || "";

      const blogIdStr = blogId ? String(blogId).trim() : "";

      const logNo =
        item.logNo || item.postId || item.articleId || null;

      const link =
        item.url ||
        item.postUrl ||
        item.blogPostUrl ||
        (blogIdStr && logNo
          ? `https://blog.naver.com/${blogIdStr}/${logNo}`
          : "");

      const meta = blogIdStr
        ? BLOG_META_MAP[blogIdStr] || null
        : null;

      if (blogIdStr && (!meta || !meta.groupNames)) {
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

      const groupName = meta?.groupNames || ""; // CSV에 있으면 전달

      const postId = logNo || null;
      if (!title || !link || !postId) return null;

      return {
        title,
        link,
        nickname,
        pubdate,
        description,
        blogId: blogIdStr,
        postId,
        groupName,
      };
    })
    .filter(Boolean);

  if (missingMetaCount > 0) {
    console.log(
      `ℹ️ ${page}페이지: CSV에 groupNames 없는 blogId ${missingMetaCount}건 (Group 미지정)`
    );
  }

  // 오래된 글 → 최신 글 순으로 Notion에 쌓기 위해 reverse
  posts = posts.reverse();

  return { posts };
}

// ───────────────────────────────────────────────
// 🚀 메인 실행
// ───────────────────────────────────────────────

async function main() {
  console.log(
    "🚀 전체 이웃 새글 → Notion 스크랩 시작 (CSV blogId/groupNames 매핑)"
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
