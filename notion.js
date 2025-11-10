/**
 * notion.js
 * ───────────────────────────────────────────────
 * 🧩 네이버 이웃새글 → Notion DB 업서트 모듈 (연도/연월/분기/Group 포함)
 *
 * ✅ 주요 기능:
 *  - UniqueID(blogId_postId)로 중복 등록 방지
 *  - pubdate로부터 연도/연월/분기 추출 및 저장
 *  - blogId를 ID 컬럼에 저장
 *  - Group 컬럼에 이웃그룹 저장 (URL 또는 응답 기반)
 *  - 기존 글이면 update, 없으면 create
 *  - 기존 내용이 동일하면 update 생략 (⏩ 변경 없음)
 *  - Description 필드는 비교 제외 → 불필요한 update 방지
 *  - ⚙️ 조회 타임아웃 발생 시 3회 재시도 후에도 실패 시 새로 생성
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

// ───────────────────────────────────────────────
// 💾 Notion
