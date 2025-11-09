/**
 * notion.js
 * ───────────────────────────────────────────────
 * 🧩 네이버 이웃새글 → Notion DB 업서트 모듈
 *
 * ✅ 주요 기능:
 *  - UniqueID(blogId_postId)로 중복 등록 방지
 *  - pubdate로부터 연도/연월/분기 추출 및 저장
 *  - blogId를 ID 컬럼에 저장
 *  - 기존 글이면 update, 없으면 create
 *  - 기존 내용이 동일하면 update 생략 (⏩ 변경 없음)
 *  - Description 필드는 비교 제외 → 불필요한 update 방지
 *  - ⚙️ 조회 타임아웃 발생 시 3회 재시도
 *    → 실패해도 "누락 방지 우선": 새 페이지 생성 시도 (중복 가능성 허용)
 */

import { Client } from "@notionhq/client";

// ───────────────────────────────────────────────
// 🔧 기본 설정
// ───────────────────────────────────────────────
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

if (!databaseId) {
  console.error("❌ NOTION_DATABASE_ID 가 설정되어 있지 않습니다.");
  process.exit(1);
}

// ───────────────────────────────────────────────
// 🕒 pubdate ISO 변환
// ───────────────────────────────────────────────
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

// ───────────────────────────────────────────────
// 📅 연도·연월·분기 추출
// ───────────────────────────────────────────────
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

// ───────────────────────────────────────────────
// 🔁 Notion 조회 재시도 함수 (최대 3회)
//   - 성공: 페이지 객체 또는 null(미존재)
//   - 최종 실패: undefined 반환 → 새로 생성 시도 (중복 가능성 허용)
// ───────────────────────────────────────────────
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
      // 존재하면 Page 객체, 없으면 null
      return query.results?.[0] || null;
    } catch (err) {
      const msg = err.code || err.message || String(err);
      console.warn(
        `⚠️ Notion 조회 실패 (${attempt}/${retries}) [${uniqueId}]: ${msg}`
      );

      if (attempt < retries) {
        const delay = 1000 * attempt; // 1s → 2s → 3s
        console.log(`⏳ ${delay / 1000}s 후 재시도합니다...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.error(
          `❌ Notion 조회 최종 실패: ${uniqueId} (중복 가능성을 감수하고 새로 생성 예정)`
        );
        // ⬇️ 조회 실패는 undefined로 반환 → 아래 upsert에서 "새로 생성" 경로로 처리
        return undefined;
      }
    }
  }
}

// ───────────────────────────────────────────────
// 💾 Notion 업서트 (있으면 update, 없으면 create)
// ───────────────────────────────────────────────
export async function upsertPost(post) {
  const blogId = post.blogId ? String(post.blogId) : "";
  const postId = post.postId ? String(post.postId) : "";

  // UniqueID = blogId_postId
  const uniqueId = blogId && postId ? `${blogId}_${postId}` : postId || null;
  if (!uniqueId) {
    console.warn("⚠️ UniqueID 없음, 스킵:", post.title);
    return;
  }

  // ── 1️⃣ 기존 데이터 조회 (재시도 포함)
  const existing = await findExistingPageWithRetry(uniqueId);
  // existing 의미:
  //   - Page 객체: 이미 있음 → update or skip
  //   - null: 정상 조회, 기존 페이지 없음 → 새로 생성
  //   - undefined: 조회 실패 → 새로 생성 시도 (중복 가능성 허용)

  if (existing === undefined) {
    console.warn(
      `⚠️ [${uniqueId}] Notion 조회에 최종 실패했지만, 누락 방지를 위해 새 페이지를 생성합니다. (중복 가능성 있음)`
    );
  }

  // ── 2️⃣ 날짜 변환
  const originalDate = normalizeNaverDate(post.pubdate);
  const createdAt = new Date().toISOString();
  const { year, yearMonth, quarter } = extractYearMonthQuarter(originalDate);

  // ── 3️⃣ 속성 매핑
  const properties = {
    Title: { title: [{ text: { content: post.title || "(제목 없음)" } }] },
    URL: { url: post.link || null },
    Nickname: { rich_text: [{ text: { content: post.nickname || "" } }] },
    ...(originalDate && { "원본 날짜": { date: { start: originalDate } } }),
    "생성 일시": { date: { start: createdAt } },
    Category: { rich_text: [{ text: { content: post.category || "" } }] },
    Description: {
      rich_text: [
        { text: { content: (post.description || "").slice(0, 1800) } },
      ],
    },
    UniqueID: { rich_text: [{ text: { content: uniqueId } }] },
    ...(blogId && { ID: { rich_text: [{ text: { content: blogId } }] } }),
    ...(year && { 연도: { rich_text: [{ text: { content: year } }] } }),
    ...(yearMonth && {
      연월: { rich_text: [{ text: { content: yearMonth } }] },
    }),
    ...(quarter && { 분기: { rich_text: [{ text: { content: quarter } }] } }),
  };

  // ── 4️⃣ 업서트 수행
  if (existing) {
    const old = existing.properties;

    // 주요 필드 비교 (Description 제외)
    const oldTitle = old.Title?.title?.[0]?.plain_text || "";
    const oldUrl = old.URL?.url || "";
    const oldCat = old.Category?.rich_text?.[0]?.plain_text || "";

    const isSame =
      oldTitle === post.title &&
      oldUrl === post.link &&
      oldCat === (post.category || "");

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
    // existing === null (정상, 미존재) or undefined(조회 실패) → 새 페이지 생성
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    });
    console.log(`🆕 새 글 추가: ${post.title}`);
  }
}
