/**
 * index.js
 * ───────────────────────────────────────────────
 * 🧭 네이버 블로그 이웃새글 → Notion 자동 스크랩 메인 실행 파일
 *
 * ✅ 작동 방식 (CSV + 전체 이웃 버전)
 *  1. NAVER_NEIGHBOR_API_URL (예: BlogHome.naver?directoryNo=0&currentPage=1&groupId=0)
 *     를 템플릿으로 사용해, MAX_PAGE부터 1페이지까지 조회한다.
 *     - page 또는 currentPage 파라미터만 변경
 *     - groupId 루프는 사용하지 않고, 템플릿 값(예: 0 = 전체)을 그대로 사용
 *  2. neighbor-followings-result.csv 를 읽어
 *     blogId → { group, nickname } 매핑을 만든다.
 *  3. 각 글 파싱 시:
 *     - 응답에서 title, blogId, postId, URL, 날짜, 닉네임, 요약 추출
 *     - CSV 매핑으로 groupName 채워서 notion.js 의 upsertPost 에 전달
 *
 * ⚠️ 전제 조건
 *  - NAVER_NEIGHBOR_API_URL:
 *      "전체 이웃 새글"용 API 템플릿 (BlogHome/BuddyPostList 등 JSON 응답)
 *  - neighbor-followings-result.csv:
 *      최소 blogId, group 컬럼 보유 (컬럼명은 유연하게 매핑)
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
// 📂 CSV → blogId 메타 매핑
// ───────────────────────────────────────────────

/**
 * neighbor-followings-result.csv 로부터
 * blogId → { group, nickname } 매핑 생성
 *
 * 허용 컬럼 예:
 *  - blogId: blogId / BLOGID / blogNo / blog_no / blog_id / "Blog ID" / id / ID
 *  - group : group / Group / groupName / GroupName / "이웃그룹" / group_name
 *  - nickname: nickname / Nickname / NICKNAME / nick / "닉네임"
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
        row.BLOGID ||
        row.blog_no ||
        row.blogNo ||
        row.blog_id ||
        row["Blog ID"] ||
        row.id ||
        row.ID;

      if (!blogIdRaw) continue;

      const blogId = String(blogIdRaw).trim();
      if (!blogId) continue;

      const groupRaw =
        row.group ||
        row.Group ||
        row.groupName ||
        row.GroupName ||
        row["이웃그룹"] ||
        row.group_name ||
        "";

      const nicknameRaw =
        row.nickname ||
        row.Nickname ||
        row.NICKNAME ||
        row.nick ||
        row["닉네임"] ||
        "";

      map[blogId] = {
        group: groupRaw ? String(groupRaw).trim() : "",
        nickname: nicknameRaw ? String(nicknameRaw).trim() : "",
      };
    }

    console.log(
      `✅ neighbor-followings-result.csv 로드 완료: ${Object.keys(map).length}개 blogId`
    );
    return map;
  } catch (err) {
    console.error(
      "❌ neighbor-followings-result.csv 파싱 실패:",
      err.message
    );
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
    // 문자열 치환 fallback
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

  let posts = list
    .map((item) => {
      const title = item.title || item.postTitle || "";
      const blogIdRaw =
        item.blogId || item.blogNo || item.bloggerId || "";
      const blogId = blogIdRaw ? String(blogIdRaw).trim() : "";

      const logNo =
        item.logNo || item.postId || item.articleId || null;

      const link =
        item.url ||
        item.postUrl ||
        item.blogPostUrl ||
        (blogId && logNo
          ? `https://blog.naver.com/${blogId}/${logNo}`
          : "");

      const meta = blogId ? BLOG_META_MAP[blogId] || {} : {};

      const nickname =
        item.nickName ||
        item.bloggerName ||
        item.userName ||
        meta.nickname ||
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

      const groupName = meta.group || ""; // CSV 기반 그룹명

      const postId = logNo || null;

      if (!title || !link || !postId) return null;

      return {
        title,
        link,
        nickname,
        pubdate,
        description,
        blogId,
        postId,
        groupName,
      };
    })
    .filter(Boolean);

  // 페이지 내 정렬: 오래된 글 → 최신 글
  posts = posts.reverse();

  return { posts };
}

// ───────────────────────────────────────────────
// 🚀 메인 실행
// ───────────────────────────────────────────────

async function main() {
  console.log(
    "🚀 전체 이웃 새글 → Notion 스크랩 시작 (CSV 기반 그룹 매핑)"
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
