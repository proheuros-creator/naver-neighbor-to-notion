/**
 * index.js
 * ───────────────────────────────────────────────
 * 🧭 네이버 블로그 이웃새글 → Notion 자동 스크랩 메인 실행 파일
 *
 * ✅ 작동 방식 (새 버전)
 *  1. NAVER_NEIGHBOR_API_URL (예: BlogHome.naver?directoryNo=0&currentPage=1&groupId=0)
 *     를 템플릿으로 사용해, "전체 이웃 새글" 페이지를 MAX_PAGE까지 조회한다.
 *     - page/currentPage 파라미터만 변경하여 1페이지부터 과거 페이지까지 순회
 *     - groupId 기반 루프는 사용하지 않는다. (groupId=0 또는 템플릿 값 유지)
 *  2. neighbor-followings-result.csv 를 읽어
 *     각 blogId 에 대응하는 group, nickname 정보를 맵으로 구성한다.
 *  3. 각 글을 파싱할 때:
 *     - 응답에서 title, blogId, postId, URL, 날짜, 닉네임, 요약 추출
 *     - CSV 매핑을 이용해 blogId 에 해당하는 group 을 찾아 groupName 으로 설정
 *     - notion.js 의 upsertPost 로 전달
 *  4. notion.js:
 *     - UniqueID(blogId_postId) 기준으로 중복 체크
 *     - Group(Text) 컬럼에 groupName 저장
 *
 * 🔐 전제 조건
 *  - NAVER_NEIGHBOR_API_URL:
 *      "전체 이웃 새글"용 BlogHome/BuddyPostList 호출 URL 템플릿이어야 한다.
 *      (예: https://section.blog.naver.com/BlogHome.naver?directoryNo=0&currentPage=1&groupId=0)
 *  - neighbor-followings-result.csv:
 *      최소한 blogId 와 group(또는 Group/groupName 등) 컬럼을 포함해야 한다.
 *      (blogId 기준으로 group 을 찾는다)
 */

import "dotenv/config";
import fetch from "node-fetch";
import { upsertPost } from "./notion.js";

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { fileURLToPath } from "url";

// ───────────────────────────────────────────────
// 📂 경로/환경 변수 설정
// ───────────────────────────────────────────────

const NAVER_COOKIE = process.env.NAVER_COOKIE;
const API_TEMPLATE = process.env.NAVER_NEIGHBOR_API_URL;
const MAX_PAGE = Number(process.env.MAX_PAGE || 150);

// neighbor-followings-result.csv 위치
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
/**
 * neighbor-followings-result.csv 로부터
 * blogId → { group, nickname } 매핑 로드
 *
 * 지원 컬럼 예시:
 *  - blogId / BLOGID / blog_id / Blog ID / id / ID
 *  - group / Group / groupName / GroupName / 이웃그룹 / group_name
 *  - nickname / Nickname / 닉네임
 */
// ───────────────────────────────────────────────

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

      const group =
        row.group ||
        row.Group ||
        row.groupName ||
        row.GroupName ||
        row["이웃그룹"] ||
        row.group_name ||
        "";

      const nickname =
        row.nickname ||
        row.Nickname ||
        row.NICKNAME ||
        row.nick ||
        row["닉네임"] ||
        "";

      map[blogId] = {
        group: group ? String(group).trim() : "",
        nickname: nickname ? String(nickname).trim() : "",
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
// 🏗 페이지 URL 생성 (page/currentPage만 변경)
// ───────────────────────────────────────────────

function buildPageUrl(page) {
  try {
    const u = new URL(API_TEMPLATE);

    // page / currentPage 교체
    if (u.searchParams.has("page")) {
      u.searchParams.set("page", String(page));
    } else if (u.searchParams.has("currentPage")) {
      u.searchParams.set("currentPage", String(page));
    } else {
      // 둘 다 없으면 page 추가
      u.searchParams.append("page", String(page));
    }

    // ⚠️ groupId 는 템플릿 값 그대로 둔다 (예: 0 = 전체)
    // 별도 groupId 루프는 사용하지 않는다.

    return u.toString();
  } catch (e) {
    // URL 객체 생성 실패 시 문자열 치환 fallback
    return API_TEMPLATE
      .replace(/(page=)\d+/, `$1${page}`)
      .replace(/(currentPage=)\d+/, `$1${page}`);
  }
}

// ───────────────────────────────────────────────
// 🧹 네이버 응답 전처리 & 디버그
// ───────────────────────────────────────────────

function stripNaverPrefix(raw) {
  return raw.replace(/^\)\]\}',?\s*/, "");
}

function cleanedPreview(raw) {
  const cleaned = stripNaverPrefix(raw || "");
  return cleaned.slice(0, 120) + (cleaned.length > 120 ? "..." : "");
}

// ───────────────────────────────────────────────
// 📥 페이지 단위 스크랩 함수
// ───────────────────────────────────────────────

/**
 * 네이버 BuddyPostList/BlogHome API에서
 * 전체 이웃 새글 목록(해당 페이지)을 가져온다.
 *
 * @param {number} page - 조회할 페이지 번호
 * @returns {Promise<{posts: Array}>}
 */
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

      const groupName = meta.group || ""; // ✅ CSV 기반 그룹명 매핑

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
        groupName, // ✅ 이제 groupId 대신 CSV에서 가져온 그룹명
      };
    })
    .filter(Boolean);

  // 네이버 응답: 일반적으로 최신 → 과거
  // Notion에는 페이지 내에서 과거 → 최신 순으로 쌓기 위해 뒤집기
  posts = posts.reverse();

  return { posts };
}

// ───────────────────────────────────────────────
// 🚀 메인 실행 루프
// ───────────────────────────────────────────────

/**
 * 전체 실행:
 *  - MAX_PAGE → 1 페이지까지 전체 이웃 새글 스크랩
 *  - 각 글은 neighbor-followings-result.csv 기반 groupName 이 포함된 상태로 upsertPost 로 전달
 */
async function main() {
  console.log(
    "🚀 BlogHome/BuddyPostList → Notion 스크랩 시작 (전체 이웃, CSV 기반 그룹 매핑)"
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
        console.error(`❌ Notion 저장 오류:`, err.message);
      }

      // 글 단위 딜레이 (Notion API 부하 완화)
      await new Promise((r) => setTimeout(r, 300));
    }

    // 페이지 단위 딜레이
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`🎉 스크랩 완료 (총 ${total}건 처리 시도)`);
}

main().catch((err) => {
  console.error("❌ 스크립트 전체 오류:", err);
  process.exit(1);
});
