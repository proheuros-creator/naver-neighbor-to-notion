/**
 * fix-ids-from-url.js
 * ───────────────────────────────────────────────
 * ✅ 목적
 *  - 이미 스크랩된 Notion 페이지들 중에서
 *    "URL에 들어있는 blogId/postId" 기준으로
 *    BlogID / UniqueID 값을 정정한다.
 *
 * ✅ 동작
 *  1. NOTION_DATABASE_ID 에서 UniqueID 가 비어있지 않은 페이지를 전부 조회
 *  2. 각 페이지의 URL 에서 https://blog.naver.com/{blogId}/{postId} 패턴 추출
 *  3. 아래 조건이면 업데이트:
 *      - 현재 BlogID != {blogId}
 *      - 현재 UniqueID != {blogId}_{postId}
 *  4. URL이 없거나, 네이버 블로그 패턴이 아니면 건드리지 않음
 *
 * ⚠️ 전제
 *  - NOTION_API_KEY, NOTION_DATABASE_ID 환경 변수 설정 필수
 *  - Notion 속성 이름:
 *      - URL      : URL 타입 컬럼
 *      - BlogID   : Rich text
 *      - UniqueID : Rich text
 */

import "dotenv/config";
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

if (!databaseId) {
  console.error("❌ NOTION_DATABASE_ID 가 설정되어 있지 않습니다.");
  process.exit(1);
}

// ───────────────────────────────────────────────
// 🧩 URL → blogId, postId 추출
// ───────────────────────────────────────────────

function extractFromUrl(url) {
  if (!url) return null;

  const m = String(url).match(
    /blog\.naver\.com\/([^\/\s]+)\/(\d+)/i
  );
  if (!m) return null;

  return {
    blogId: m[1],
    postId: m[2],
    uniqueId: `${m[1]}_${m[2]}`,
  };
}

// ───────────────────────────────────────────────
// 🔎 UniqueID 있는 페이지 전체 조회
// ───────────────────────────────────────────────

async function getAllPagesWithUniqueId() {
  const pages = [];
  let cursor = undefined;

  while (true) {
    const res = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
      filter: {
        property: "UniqueID",
        rich_text: { is_not_empty: true },
      },
    });

    pages.push(...res.results);

    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  return pages;
}

// ───────────────────────────────────────────────
// 🛠 메인 로직
// ───────────────────────────────────────────────

async function fixIdsFromUrl() {
  console.log("🚀 UniqueID 있는 페이지 조회 시작...");

  const pages = await getAllPagesWithUniqueId();
  console.log(`📦 대상 페이지 수: ${pages.length}개`);

  let checked = 0;
  let updated = 0;
  let skippedNoUrl = 0;
  let skippedNoPattern = 0;
  let alreadyOk = 0;

  for (const page of pages) {
    checked++;

    const props = page.properties || {};

    const url = props.URL?.url || null;
    if (!url) {
      skippedNoUrl++;
      continue;
    }

    const parsed = extractFromUrl(url);
    if (!parsed) {
      // 네이버 블로그 URL 형식이 아니면 스킵
      skippedNoPattern++;
      continue;
    }

    const { blogId, postId, uniqueId } = parsed;

    const oldBlogId =
      props.BlogID?.rich_text?.[0]?.plain_text || "";
    const oldUniqueId =
      props.UniqueID?.rich_text?.[0]?.plain_text || "";

    const needsBlogIdUpdate = oldBlogId !== blogId;
    const needsUniqueIdUpdate = oldUniqueId !== uniqueId;

    if (!needsBlogIdUpdate && !needsUniqueIdUpdate) {
      alreadyOk++;
      continue;
    }

    const properties = {};

    if (needsBlogIdUpdate) {
      properties.BlogID = {
        rich_text: [
          {
            text: { content: blogId },
          },
        ],
      };
    }

    if (needsUniqueIdUpdate) {
      properties.UniqueID = {
        rich_text: [
          {
            text: { content: uniqueId },
          },
        ],
      };
    }

    try {
      await notion.pages.update({
        page_id: page.id,
        properties,
      });

      updated++;

      console.log(
        `🔄 수정: ${page.id} | URL=${url}` +
          (needsBlogIdUpdate
            ? ` | BlogID: '${oldBlogId}' → '${blogId}'`
            : "") +
          (needsUniqueIdUpdate
            ? ` | UniqueID: '${oldUniqueId}' → '${uniqueId}'`
            : "")
      );
    } catch (err) {
      console.error(
        `❌ 업데이트 실패 (page ${page.id}):`,
        err.message || err
      );
    }

    // Notion 레이트 리밋 방지용 살짝 딜레이
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log("✅ 처리 완료 요약");
  console.log(`  - 확인한 페이지: ${checked}`);
  console.log(`  - 수정된 페이지: ${updated}`);
  console.log(`  - 이미 일치 (건드리지 않음): ${alreadyOk}`);
  console.log(`  - URL 없음 (스킵): ${skippedNoUrl}`);
  console.log(`  - 네이버 패턴 아님 (스킵): ${skippedNoPattern}`);
}

// ───────────────────────────────────────────────
// 실행
// ───────────────────────────────────────────────

fixIdsFromUrl().catch((err) => {
  console.error("❌ 스크립트 전체 오류:", err);
  process.exit(1);
});
