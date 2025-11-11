/**
 * notion.js
 * ───────────────────────────────────────────────
 * 🧩 네이버 이웃새글 → Notion DB 업서트 모듈
 *
 * ✅ 규칙
 *  - UniqueID = blogId_postId (또는 postId)
 *  - BlogID(Text) 컬럼에 blogId 저장
 *  - Group(Multi-select) 컬럼에 groupNames 저장
 *      - CSV groupNames: "A,B,C" → ["A","B","C"] 옵션으로 설정
 *  - CSV에 groupNames 있으면 → 그 값으로 Group 덮어쓰기
 *  - CSV에 groupNames 없으면 → 기존 Group 유지
 *  - Title / URL / Category / Group 모두 동일하면 update 스킵
 */

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

if (!databaseId) {
  console.error("❌ NOTION_DATABASE_ID 가 설정되어 있지 않습니다.");
  process.exit(1);
}

// ───────────────────────────────────────────────
// 날짜 유틸
// ───────────────────────────────────────────────

function normalizeNaverDate(raw) {
  if (!raw) return null;
  if (typeof raw === "number") return new Date(raw).toISOString();

  const s = String(raw).trim();

  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  if (/^\d{10}$/.test(s))
    return new Date(Number(s) * 1000).toISOString();

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
// UniqueID 조회 (재시도)
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
        console.log(`⏳ ${delay / 1000}s 후 재시도...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.error(
          `❌ Notion 조회 최종 실패: ${uniqueId} (중복 가능성 감수 후 새로 생성 예정)`
        );
        return undefined;
      }
    }
  }
}

// ───────────────────────────────────────────────
// Group (multi-select) 유틸
// ───────────────────────────────────────────────

function parseGroupNames(groupNamesStr) {
  if (!groupNamesStr) return [];
  return String(groupNamesStr)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .sort();
}

function buildGroupMultiSelectFromNames(names) {
  if (!names
