/**
 * notion.js
 * ───────────────────────────────────────────────
 * 🧩 네이버 이웃새글 → Notion DB 업서트 모듈
 *
 * ✅ 주요 기능:
 *  - UniqueID(blogId_postId)로 중복 등록 방지
 *  - pubdate로부터 연도/연월/분기 추출 및 저장
 *  - blogId를 ID 컬럼에 저장
 *  - Group 컬럼에 이웃그룹 저장
 *  - 기존 글이면 update, 없으면 create
 *  - 기존 내용 동일 시 update 생략 (⏩)
 *  - Description 비교 제외 (불필요한 업데이트 방지)
 *  - Notion 조회 타임아웃 시 최대 3회 재시도
 *    → 모두 실패 시에도 누락 방지를 위해 새 페이지 생성 시도 (중복 허용)
 */

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

if (!databaseId) {
  console.error("❌ NOTION_DATABASE_ID 가 설정되어 있지 않습니다.");
  process.exit(1);
}

// 🕒 pubdate ISO 변환
function normalizeNaverDate(raw) {
  if (!raw) return null;

  if (typeof raw === "number") return new Date(raw).toISOString();

  const s = String(raw).trim();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();

  const replaced = s
    .replace(/\./g, "-")
    .replace(/\//g, "-")
    .replace("년", "-")
    .replace("월", "-")
    .replace("일", "")
    .trim();

  const d = new Date(replaced);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// 📅 연도·연월·분기 추출
function extractYearMonthQuarter(isoString) {
  if (!isoString) return { year: "", yearMonth: "", quarter: "" };
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return { year: "", yearMonth: "", quarter: "" };

  const year = String(d.getFullYear());
  const month = d.getMonth() + 1;
  const mm = String(month).padStart(2, "0");
  const yearMonth = `${year}-${mm}`;
  const q = month <= 3 ? "Q1" : month <= 6 ? "Q2" : month <= 9 ? "Q3" : "Q4";
  const quarter = `${year}-${q}`;
  return { year, yearMonth, quarter };
}

// 🔁 Notion 조회 재시도 (최대 3회)
//  - 성공: Page 객체 또는 null(없음)
//  - 실패: undefined (이 경우 새로 생성 시도)
async function findExistingPageWithRetry(uniqueId, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const query = await notion.databases.query({
        database_id: databaseId,
        filter: {
          property: "UniqueID",
          rich_text: { equals: uniqueId },
        },
      });
      return query.results?.[0] || null;
    } catch (err) {
      const msg = err.code || err.message || String(err);
      console.warn(
        `⚠️ Notion 조회 실패 (${attempt}/${retries}) [${uniqueId}]: ${msg}`
      );

      if (attempt < retries) {
        const delay = 1000 * attempt;
        console.log(`⏳ ${delay / 1000}s 후 재시도합니다...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.error(
          `❌ Notion 조회 최종 실패: ${uniqueId} (중복 가능성 감수, 새 페이지 생성 예정)`
        );
        return undefined;
      }
    }
  }
}

// 💾 업서트
export async function upsertPost(post) {
  const blogId = post.blogId ? String(post.blogId) : "";
  const postId = post.postId ? String(post.postId) : "";

  // UniqueID = blogId_postId
  const uniqueId = blogId && postId ? `${blogId}_${postId}` : postId || null;
  if (!uniqueId) {
    console.warn("⚠️ UniqueID 없음, 스킵:", post.title);
    return;
  }

  const existing = await findExistingPageWithRetry(uniqueId);
  // existing:
  //  - Page 객체 → 이미 있음
  //  - null      → 없음 (정상 조회)
  //  - undefined → 조회 실패 (그래도 생성은 시도)

  if (existing === undefined) {
    console.warn(
      `⚠️ [${uniqueId}] Notion 조회 실패 → 누락 방지를 위해 새로 생성 시도 (중복 가능성 있음)`
    );
  }

  const originalDate = normalizeNaverDate(post.pubdate);
  const createdAt = new Date().toISOString();
  const { year, yearMonth, quarter } = extractYearMonthQuarter(originalDate);

  // Group(이웃 그룹) 값 정리
  const groupValue = post.group ? String(post.group) : "";

  // 속성 매핑
  const properties = {
    Title: { title: [{ text: { content: post.title || "(제목 없음)" } }] },
    URL: { url: post.link || null },
    Nickname: { rich_text: [{ text: { content: post.nickname || "" } }] },
    ...(originalDate && { "원본 날짜": { date: { start: originalDate } } }),
    "생성 일시": { date: { start: createdAt } },
    Category: {
      rich_text: [{ text: { content: post.category || "" } }],
    },
    Description: {
      rich_text: [
        { text: { content: (post.description || "").slice(0, 1800) } },
      ],
    },
    UniqueID: { rich_text: [{ text: { content: uniqueId } }] },
    ...(blogId && { ID: { rich_text: [{ text: { content: blogId } }] } }),
    ...(groupValue && {
      Group: { rich_text: [{ text: { content: groupValue } }] },
    }),
    ...(year && { 연도: { rich_text: [{ text: { content: year } }] } }),
    ...(yearMonth && {
      연월: { rich_text: [{ text: { content: yearMonth } }] },
    }),
    ...(quarter && { 분기: { rich_text: [{ text: { content: quarter } }] } }),
  };

  // ✅ 기존 페이지 있는 경우: 변경 여부 체크 후 업데이트
  if (existing) {
    const old = existing.properties;

    const oldTitle = old.Title?.title?.[0]?.plain_text || "";
    const oldUrl = old.URL?.url || "";
    const oldCat = old.Category?.rich_text?.[0]?.plain_text || "";
    const oldGroup = old.Group?.rich_text?.[0]?.plain_text || "";

    const isSame =
      oldTitle === (post.title || "(제목 없음)") &&
      oldUrl === (post.link || null) &&
      oldCat === (post.category || "") &&
      // 👉 Group 비교 포함: 비어있던 Group 채워야 하면 isSame=false가 되어 업데이트 수행
      oldGroup === groupValue;

    if (isSame) {
      console.log(`⏩ 변경 없음 (스킵): ${post.title}`);
      return;
    }

    await notion.pages.update({
      page_id: existing.id,
      properties,
    });
    console.log(`🔄 업데이트: ${post.title}`);
  } else {
    // 기존 페이지 없음(null) or 조회 실패(undefined) → 새로 생성
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    });
    console.log(`🆕 새 글 추가: ${post.title}`);
  }
}
