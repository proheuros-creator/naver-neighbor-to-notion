/**
 * index.js
 * ───────────────────────────────────────────────
 * 🧭 네이버 블로그 이웃새글 → Notion 자동 스크랩 메인 실행 파일
 *
 * ✅ 주요 기능:
 *  - groups.js에 정의된 groupId 2~14 전체 순회
 *  - 각 그룹별로 NAVER_NEIGHBOR_API_URL 호출
 *  - groupId별 Group 이름을 Notion에 기록
 */

import "dotenv/config";
import fetch from "node-fetch";
import { upsertPost } from "./notion.js";
import { GROUPS } from "./groups.js";

const NAVER_COOKIE = process.env.NAVER_COOKIE;
const API_TEMPLATE = process.env.NAVER_NEIGHBOR_API_URL;
const MAX_PAGE = Number(process.env.MAX_PAGE || 150);

// 필수 환경변수 확인
if (!NAVER_COOKIE || !API_TEMPLATE) {
  console.error("❌ NAVER_COOKIE 또는 NAVER_NEIGHBOR_API_URL 누락");
  process.exit(1);
}

/** 페이지 URL 생성 */
function buildPageUrl(page, groupId) {
  try {
    const url = new URL(API_TEMPLATE);
    url.searchParams.set("currentPage", String(page));
    url.searchParams.set("groupId", String(groupId));
    return url.toString();
  } catch (e) {
    return API_TEMPLATE
      .replace(/currentPage=\d+/, `currentPage=${page}`)
      .replace(/groupId=\d+/, `groupId=${groupId}`);
  }
}

/** 보안 prefix 제거 */
function stripNaverPrefix(raw) {
  return raw.replace(/^\)\]\}',?\s*/, "");
}

/** JSON 파싱 실패 시 미리보기 출력 */
function cleanedPreview(raw) {
  const cleaned = stripNaverPrefix(raw || "");
  return cleaned.slice(0, 120) + (cleaned.length > 120 ? "..." : "");
}

/** 특정 그룹의 페이지 데이터 가져오기 */
async function fetchPagePosts(page, groupId) {
  const url = buildPageUrl(page, groupId);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (NaverNeighborScraper)",
      Cookie: NAVER_COOKIE,
      Accept: "application/json, text/plain, */*",
      Referer: "https://section.blog.naver.com/BlogHome.naver",
    },
  });

  if (!res.ok) {
    console.error(`❌ groupId=${groupId} | ${page}페이지 요청 실패: ${res.status}`);
    return { posts: [] };
  }

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(stripNaverPrefix(raw));
  } catch (e) {
    console.error(`❌ JSON 파싱 실패 (groupId=${groupId}, page=${page}):`, e.message);
    console.error(cleanedPreview(raw));
    return { posts: [] };
  }

  const result = data.result || data;
  const list =
    result.buddyPostList || result.postList || result.list || result.items || [];

  let posts = list
    .map((item) => {
      const title = item.title || item.postTitle || "";
      const blogId = item.blogId || item.blogNo || item.bloggerId || "";
      const logNo = item.logNo || item.postId || item.articleId || null;
      const link =
        item.url ||
        item.postUrl ||
        item.blogPostUrl ||
        (blogId && logNo ? `https://blog.naver.com/${blogId}/${logNo}` : "");
      const nickname = item.nickName || item.bloggerName || item.userName || "";
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

      if (!title || !link || !logNo) return null;

      return {
        title,
        link,
        nickname,
        pubdate,
        description,
        blogId,
        postId: logNo,
      };
    })
    .filter(Boolean)
    .reverse();

  return { posts };
}

/** 메인 실행: 그룹 전체 순회 */
async function main() {
  console.log("🚀 네이버 블로그 이웃새글 → Notion 스크랩 시작 (그룹 전체)");

  for (const group of GROUPS) {
    const { id: groupId, name: groupName } = group;
    console.log(`\n📂 그룹 [${groupName}] (ID=${groupId}) 처리 시작`);
    let total = 0;

    for (let page = MAX_PAGE; page >= 1; page--) {
      const { posts } = await fetchPagePosts(page, groupId);
      console.log(`📥 ${page}페이지 (${groupName}) 글 수: ${posts.length}`);
      total += posts.length;

      for (const post of posts) {
        try {
          await upsertPost({ ...post, group: groupName }); // group 속성 전달
        } catch (err) {
          console.error(`❌ Notion 저장 오류 (${groupName}):`, err.message);
        }
        await new Promise((r) => setTimeout(r, 300));
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log(`✅ 그룹 [${groupName}] 처리 완료 (총 ${total}건)`);
  }

  console.log("🎉 모든 그룹 스크랩 완료!");
}

main().catch((err) => {
  console.error("❌ 전체 오류:", err);
  process.exit(1);
});
