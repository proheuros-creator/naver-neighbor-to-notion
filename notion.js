/**
 * notion.js
 * ───────────────────────────────────────────────
 * 🧩 네이버 이웃새글 → Notion DB 업서트 모듈 (ESM 버전)
 *
 * ✅ 주요 기능:
 *  - UniqueID(blogId_postId)로 중복 등록 방지
 *  - pubdate로부터 연도/연월/분기 추출
 *  - blogId를 ID 컬럼에 저장
 *  - Group(이웃그룹) 컬럼 지원
 *  - 기존 글이면 update, 없으면 create
 *  - 기존 내용이 동일하면 update 생략 (⏩ 변경 없음)
 *  - Group 비어 있으면 새 값으로 채움
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
// 🔁 Notion 조회 (UniqueID 기준, 최대 3회 재시도)
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
      console.warn(`⚠️ Notion 조회 실패 (${attempt}/${retries}) [${uniqueId}]: ${msg}`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      } else {
        console.error(`❌ Notion 조회 최종 실패: ${uniqueId}`);
        return undefined;
      }
    }
  }
}

// ───────────────────────────────────────────────
// 💾 Notion 업서트 (있으면 update, 없으면 create)
// ───────────────────────────────────────────────
async function upsertPost(post) {
  const blogId = post.blogId ? String(post.blogId) : "";
  const postId = post.postId ? String(post.postId) : "";
  const uniqueId = blogId && postId ? `${blogId}_${postId}` : postId || null;

  if (!uniqueId) {
    console.warn("⚠️ UniqueID 없음, 스킵:", post.title);
    return;
  }

  const existing = await findExistingPageWithRetry(uniqueId);

  const originalDate = normalizeNaverDate(post.pubdate);
  const createdAt = new Date().toISOString();
  const { year, yearMonth, quarter } = extractYearMonthQuarter(originalDate);

  // ── 속성 매핑
  const properties = {
    Title: { title: [{ text: { content: post.title || "(제목 없음)" } }] },
    URL: { url: post.link || null },
    Nickname: { rich_text: [{ text: { content: post.nickname || "" } }] },
    ...(originalDate && { "원본 날짜": { date: { start: originalDate } } }),
    "생성 일시": { date: { start: createdAt } },
    Category: { rich_text: [{ text: { content: post.category || "" } }] },
    Description: {
      rich_text: [{ text: { content: (post.description || "").slice(0, 1800) } }],
    },
    UniqueID: { rich_text: [{ text: { content: uniqueId } }] },
    ...(blogId && { ID: { rich_text: [{ text
