/**
 * index.js
 * ───────────────────────────────────────────────
 * 🧭 네이버 블로그 이웃새글 → Notion 자동 스크랩 메인 실행 파일
 *
 * ✅ 동작 개요
 *  1. NAVER_NEIGHBOR_API_URL (예: BlogHome.naver?directoryNo=0&currentPage=1&groupId=0)
 *     를 템플릿으로 사용해 MAX_PAGE → 1 페이지까지 조회.
 *     - page 또는 currentPage 파라미터만 변경
 *     - groupId 루프 없음 (0 = 전체 이웃 기준)
 *  2. neighbor-followings-result.csv 를 읽어
 *     blogID → groupNames 매핑 생성.
 *  3. 네이버 응답에서 각 글의 blogId를 기준으로:
 *     - post.blogId = blogID
 *     - post.groupName = groupNames (문자열)
 *     을 붙여 notion.js/upsertPost 로 전달.
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
// 📂 CSV → blogID / groupNames 매핑
// ───────────────────────────────────────────────

/**
 * neighbor-followings-result.csv
 *   - blogID
 *   - groupNames
 *
 * 형식 기준으로:
 *  map[blogId] = { groupNames }
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
      // blogID 컬럼 우선 사용
      const blogIdRaw =
        row.blogID ||
        row.blogId ||
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

      // groupNames 컬럼 우선 사용
      const groupNamesRaw =
        row.groupNames ||
        row.groupName ||
        row.GroupNames ||
        row.GroupName ||
        row.group ||
        row.Group ||
        "";

      // 닉네임이 CSV에 있다면 옵션으로 같이 써도 됨 (지금은 필수 아님)
      const nicknameRaw =
        row.nickname ||
        row.Nickname ||
        row.NICKNAME ||
        row.nick ||
        row["닉네임"] ||
        "";

      map[blogId] = {
        groupNames: groupNamesRaw
          ? String(groupNamesRaw).trim()
          : "",
        nickname: nicknameRaw ? String(nicknameRaw).trim() : "",
      };
    }

    console.log(
      `✅ CSV 로드 완료: ${Object.keys(map).length}개 blogID → groupNames 매핑`
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

    // groupId는 템플릿 값 유지 (예: 0 = 전체)
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
// 🧹 응답 전처리
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
      const blogIdRaw =
        item
