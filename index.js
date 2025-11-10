/**
 * index.js
 * ───────────────────────────────────────────────
 * 🧭 네이버 블로그 이웃새글 → Notion 자동 스크랩 메인 실행 파일
 * 
 * ✅ 주요 기능:
 *  - NAVER_NEIGHBOR_API_URL 기반 BuddyPostList 반복 호출
 *  - MAX_PAGE → 1 페이지까지 역순(최신 페이지 우선) 스크랩
 *  - 각 페이지 내 글은 “아래 → 위” (오래된 → 최신) 순으로 처리
 *  - blogId + postId 조합 UniqueID로 중복 방지
 *  - 필요 시 Group(이웃그룹) 정보 함께 전달
 */

import "dotenv/config";
import fetch from "node-fetch";
import { upsertPost } from "./notion.js";

// ───────────────────────────────────────────────
// 🔧 환경 변수
// ───────────────────────────────────────────────
const NAVER_COOKIE = process.env.NAVER_COOKIE;
const API_TEMPLATE = process.env.NAVER_NEIGHBOR_API_URL;
const MAX_PAGE = Number(process.env.MAX_PAGE || 150);

// 선택: 이 워크플로우가 어떤 이웃그룹에서 온 건지 표시하고 싶을 때 사용
// 예: 전체이웃, 투자, 공부, etc.
const GROUP_NAME = process.env.NAVER_NEIGHBOR_GROUP || "전체이웃";

// 필수값 검증
if (!NAVER_COOKIE) {
  console.error("❌ NAVER_COOKIE 가 설정되어 있지 않습니다.");
  process.exit(1);
}

if (!API_TEMPLATE) {
  console.error("❌ NAVER_NEIGHBOR_API_URL 이 설정되어 있지 않습니다.");
  process.exit(1);
}

// ───────────────────────────────────────────────
// 📄 페이지별 URL 생성
//   - NAVER_NEIGHBOR_API_URL 에 page 또는 currentPage 가 들어있다는 가정
//   - 없으면 그냥 page 파라미터를 추가
// ───────────────────────────────────────────────
function buildPageUrl(page) {
  try {
    const url = new URL(API_TEMPLATE);

    // BuddyPostList 쪽은 보통 ?page=1 이거나 ?currentPage=1 형태
    if (url.searchParams.has("page")) {
      url.searchParams.set("page", String(page));
    }
    if (url.searchParams.has("currentPage")) {
      url.searchParams.set("currentPage", String(page));
    }

    // page/currentPage 둘 다 없으면 page 추가
    if (!url.searchParams.has("page") && !url.searchParams.has("currentPage")) {
      url.searchParams.set("page", String(page));
    }

    return url.toString();
  } catch (e) {
    // URL 파싱 실패 시 문자열 치환 fallback
    return API_TEMPLATE
      .replace(/page=\d+/, `page=${page}`)
      .replace(/currentPage=\d+/, `currentPage=${page}`);
  }
}

// ───────────────────────────────────────────────
// 🔐 네이버 응답 앞부분 prefix 제거 (")]}'," 같은거)
// ───────────────────────────────────────────────
function stripNaverPrefix(raw) {
  return raw.replace(/^\)\]\}',?\s*/, "");
}

// 디버깅용: JSON 파싱 실패 시 앞부분만 출력
function cleanedPreview(raw) {
  const cleaned = stripNaverPrefix(raw || "");
  return cleaned.slice(0, 120) + (cleaned.length > 120 ? "..." : "");
}

// ───────────────────────────────────────────────
// 📥 특정 페이지 글 목록 가져오기
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
      const blogId =
        item.blogId || item.blogNo || item.bloggerId || "";
      const logNo =
        item.logNo || item.postId || item.articleId || null;

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

      if (!title || !link || !postId) return null;

      return {
        title,
        link,
        nickname,
        pubdate,
        description,
        blogId,
        postId,
        group: GROUP_NAME, // 👈 이 워크플로우가 대표하는 이웃그룹 이름
      };
    })
    .filter(Boolean);

  // 페이지 내: 아래→위 (오래된→최신) 순서로 정렬
  posts = posts.reverse();

  return { posts };
}

// ───────────────────────────────────────────────
// 🚀 메인 실행 루프
// ───────────────────────────────────────────────
async function main() {
  console.log("🚀 BuddyPostList API → Notion 스크랩 시작");
  console.log(
    `📄 대상 페이지: ${MAX_PAGE} → 1 (내림차순, 각 페이지는 아래→위 순서)`
  );
  console.log(`📂 이웃 그룹: ${GROUP_NAME}`);

  let total = 0;

  for (let page = MAX_PAGE; page >= 1; page--) {
    const { posts } = await fetchPagePosts(page);
    console.log(`📥 ${page}페이지에서 가져온 글 수: ${posts.length}`);
    total += posts.length;

    for (const post of posts) {
      try {
        await upsertPost(post);
      } catch (err) {
        console.error("❌ Notion 저장 오류:", err.message);
      }

      // Notion API 부하 완화
      await new Promise((r) => setTimeout(r, 300));
    }

    // 페이지 간 대기
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`✅ 전체 스크랩 완료. 총 ${total}건 처리 시도.`);
}

main().catch((err) => {
  console.error("❌ 스크립트 전체 오류:", err);
  process.exit(1);
});
