/**
 * index.js
 * ───────────────────────────────────────────────
 * 🧭 네이버 블로그 이웃새글 → Notion 자동 스크랩 메인 실행 파일
 *
 * ✅ 작동 방식 (현재 버전)
 *  1. groups.js 에 정의된 모든 이웃그룹(GROUPS 배열)을 순회한다.
 *     - 각 원소: { id: groupId, name: "그룹이름" }
 *     - 이 배열 순서대로 스크랩이 진행된다.
 *  2. 각 그룹에 대해:
 *     - MAX_PAGE → 1 페이지까지 역순(최신 페이지부터 과거 페이지로) 순회
 *     - 각 페이지에서 BuddyPostList API 호출
 *     - 응답에서 title, blogId, postId, URL, 날짜, 닉네임, 요약을 파싱
 *     - 각 글에 groupName(이웃그룹 이름)을 붙여 notion.js 로 전달
 *  3. notion.js 의 upsertPost 가:
 *     - UniqueID = blogId_postId 기준으로 중복 체크
 *     - 이미 있으면 변경 여부 확인 후 update 또는 스킵
 *     - 없으면 새 페이지 생성
 *
 * 🔐 전제 조건
 *  - NAVER_NEIGHBOR_API_URL 은 유효한 BuddyPostList 호출 URL이어야 한다.
 *    (예: https://section.blog.naver.com/ajax/BuddyPostList.naver?page=1&groupId=4 ...)
 *  - groups.js 에 정의된 groupId 들은 실제 네이버 이웃그룹의 ID와 일치해야 한다.
 */

import "dotenv/config";
import fetch from "node-fetch";
import { upsertPost } from "./notion.js";
import { GROUPS } from "./groups.js";

// ───────────────────────────────────────────────
// 🔧 환경변수 로드 & 검증
// ───────────────────────────────────────────────

const NAVER_COOKIE = process.env.NAVER_COOKIE;
const API_TEMPLATE = process.env.NAVER_NEIGHBOR_API_URL;
const MAX_PAGE = Number(process.env.MAX_PAGE || 150);

if (!NAVER_COOKIE) {
  console.error("❌ NAVER_COOKIE 가 설정되어 있지 않습니다.");
  process.exit(1);
}

if (!API_TEMPLATE) {
  console.error("❌ NAVER_NEIGHBOR_API_URL 이 설정되어 있지 않습니다.");
  process.exit(1);
}

// ───────────────────────────────────────────────
// 🏗 BuddyPostList URL 생성
// ───────────────────────────────────────────────

/**
 * 특정 page, groupId 조합에 대한 API URL 생성
 *
 * - NAVER_NEIGHBOR_API_URL 을 템플릿으로 사용
 * - 내부에 page 또는 currentPage, groupId 파라미터가 있으면 교체
 * - 없으면 추가
 */
function buildPageUrl(page, groupId) {
  try {
    const u = new URL(API_TEMPLATE);

    // page / currentPage 교체
    if (u.searchParams.has("page")) {
      u.searchParams.set("page", String(page));
    } else if (u.searchParams.has("currentPage")) {
      u.searchParams.set("currentPage", String(page));
    } else {
      u.searchParams.append("page", String(page));
    }

    // groupId 교체 또는 추가
    if (u.searchParams.has("groupId")) {
      u.searchParams.set("groupId", String(groupId));
    } else {
      u.searchParams.append("groupId", String(groupId));
    }

    return u.toString();
  } catch (e) {
    // URL 객체 생성 실패 시 문자열 치환 fallback
    return API_TEMPLATE
      .replace(/(page=)\d+/, `$1${page}`)
      .replace(/(currentPage=)\d+/, `$1${page}`)
      .replace(/(groupId=)\d+/, `$1${groupId}`);
  }
}

// ───────────────────────────────────────────────
// 🧹 네이버 응답 전처리 & 디버그
// ───────────────────────────────────────────────

/**
 * 네이버 JSON 응답 앞의 보안 prefix 제거
 *  - 예: ")]}'," 같은 문자열 제거
 */
function stripNaverPrefix(raw) {
  return raw.replace(/^\)\]\}',?\s*/, "");
}

/**
 * JSON 파싱 실패 시 앞부분만 잘라 보여주는 도우미
 */
function cleanedPreview(raw) {
  const cleaned = stripNaverPrefix(raw || "");
  return cleaned.slice(0, 120) + (cleaned.length > 120 ? "..." : "");
}

// ───────────────────────────────────────────────
// 📥 페이지 단위 스크랩 함수
// ───────────────────────────────────────────────

/**
 * 네이버 BuddyPostList API에서 특정 그룹/페이지의 글 목록을 가져온다.
 *
 * @param {number} page       - 조회할 페이지 번호
 * @param {number} groupId    - 이웃 그룹 ID
 * @param {string} groupName  - 이웃 그룹 이름 (Notion Group 컬럼에 저장)
 * @returns {Promise<{posts: Array}>}
 */
async function fetchPagePosts(page, groupId, groupName) {
  const url = buildPageUrl(page, groupId);

  // 쿠키 인증 포함 (로그인 기반 이웃 글 접근용)
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (NaverNeighborScraper)",
      Cookie: NAVER_COOKIE,
      Accept: "application/json, text/plain, */*",
      Referer: "https://section.blog.naver.com/BlogHome.naver",
    },
  });

  // HTTP 에러 처리
  if (!res.ok) {
    console.error(
      `❌ [${groupName}] ${page}페이지 API 요청 실패:`,
      res.status,
      res.statusText
    );
    return { posts: [] };
  }

  const raw = await res.text();

  // JSON 파싱
  let data;
  try {
    const cleaned = stripNaverPrefix(raw);
    data = JSON.parse(cleaned);
  } catch (e) {
    console.error(
      `❌ [${groupName}] ${page}페이지 JSON 파싱 실패:`,
      e.message
    );
    console.error(cleanedPreview(raw));
    return { posts: [] };
  }

  // 응답 구조에서 리스트 부분 추출 (버전에 따라 키가 다를 수 있어 안전하게 처리)
  const result = data.result || data;
  const list =
    result.buddyPostList ||
    result.postList ||
    result.list ||
    result.items ||
    [];

  // 필요한 필드만 추출 → upsertPost 에 넘김
  let posts = list
    .map((item) => {
      const title = item.title || item.postTitle || "";
      const blogId =
        item.blogId || item.blogNo || item.bloggerId || "";
      const logNo =
        item.logNo || item.postId || item.articleId || null;

      // 블로그 글 URL
      const link =
        item.url ||
        item.postUrl ||
        item.blogPostUrl ||
        (blogId && logNo
          ? `https://blog.naver.com/${blogId}/${logNo}`
          : "");

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

      const postId = logNo || null;

      // 필수 값이 없으면 스킵
      if (!title || !link || !postId) return null;

      return {
        title,
        link,
        nickname,
        pubdate,
        description,
        blogId,
        postId,
        groupName, // ✅ 이 글이 어떤 이웃그룹에서 온 것인지 함께 넘김
      };
    })
    .filter(Boolean);

  // 네이버 응답은 일반적으로 "최신 → 과거" 이므로
  // 우리는 페이지 내에서 "과거 → 최신" 순으로 저장하기 위해 뒤집음
  posts = posts.reverse();

  return { posts };
}

// ───────────────────────────────────────────────
// 🚀 메인 실행 루프
// ───────────────────────────────────────────────

/**
 * 전체 실행:
 *  - groups.js의 GROUPS 순서대로
 *  - 각 그룹에 대해 MAX_PAGE → 1 페이지까지 스크랩
 *  - 각 글은 notion.js의 upsertPost로 전달
 */
async function main() {
  console.log("🚀 BuddyPostList API → Notion 스크랩 시작 (모든 그룹)");

  for (const { id: groupId, name: groupName } of GROUPS) {
    console.log(`📂 그룹 [${groupName}] (ID=${groupId}) 처리 시작`);
    let total = 0;

    for (let page = MAX_PAGE; page >= 1; page--) {
      const { posts } = await fetchPagePosts(page, groupId, groupName);
      console.log(
        `📥 ${page}페이지 (${groupName}) 글 수: ${posts.length}`
      );
      total += posts.length;

      // 오래된 글 → 최신 글 순서로 업서트
      for (const post of posts) {
        try {
          await upsertPost(post);
        } catch (err) {
          console.error(
            `❌ Notion 저장 오류 (${groupName}):`,
            err.message
          );
        }

        // 글 단위 딜레이 (Notion API 부하 완화)
        await new Promise((r) => setTimeout(r, 300));
      }

      // 페이지 단위 딜레이
      await new Promise((r) => setTimeout(r, 500));
    }

    console.log(
      `✅ 그룹 [${groupName}] 처리 완료 (총 ${total}건 처리 시도)`
    );
  }

  console.log("🎉 모든 그룹 스크랩 완료");
}

main().catch((err) => {
  console.error("❌ 스크립트 전체 오류:", err);
  process.exit(1);
});
