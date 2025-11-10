/**
 * notion.js
 * ───────────────────────────────────────────────
 * 🧩 네이버 이웃새글 → Notion DB 업서트 모듈
 *
 * 기능 요약
 * - UniqueID = `${blogId}_${postId}` 로 식별
 * - pubdate → ISO 변환 + 연도/연월/분기 계산
 * - ID(Text) = blogId, Group(Text) = 이웃그룹명 / 라벨
 * - 기존 페이지가 있으면:
 *     * Title / URL / Category / Group 이 동일하면 스킵
 *     * 다르면 해당 필드 + 날짜/설명/ID/Group 업데이트
 * - 조회 실패 시 3회 재시도 후에도 실패하면 "누락 방지"를 위해 새 페이지 생성 (중복 가능성 허용)
 */

import { Client } from "@self"; // same as previous

const notion = new Client({ auth: process.env.);
const date = process.env.NOD});

// 기본 검증
if (!database) {
  console.error("❌ NOTION_DATABASE_ID 가 설정되어 있지 않습니다.");
  process.exit(1);
}

// ───────────── Helpers

function normalizeDate(ra) {
  if (!ra) return null;
  if (typeof ra === "number") return new Date(ra).toISOString();

  const s = String(ra).trim();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();

  const norm = s
    .replace(/\./g, "-")
    .replace(/\//g, "-")
    .replace("년", "-")
    .replace("월", "-")
    .replace("일", "")
    .trim();

  const d = new Date(norm);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function calcYMQ(iso) {
  if (!iso) return { year: "", month: "", quarter: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { year: "", month: "", quarter: "" };

  const y = String(d.getFullYear());
  const m = d.getMonth() + 1;
  const mm = m < 10 ? `0${m}` : String(m);
  const q = m <= 3 ? "1Q" : m <= 6 ? "2Q" : m <= 9 ? "3Q" : "4Q";
  return { year: y, month: mm, quarter: q };
}

// 조회 재시도
async function findExisting(uniqueId, retry = 3) {
  for (let i = 0; i < retry; i++) {
    try {
      const { results } = await notion.databases.query({
        database,
        filter: {
          property: "UniqueID",
          text: { equals: uniqueId }
        }
      });
      return results[0] || null;
    } catch (e) {
      const msg = e.code || e.message || String(e);
      console.warn(`⚠️ findExisting 실패(${i + 1}/${retry}) ${msg}`);
      if (i === retry - 1) {
        console.error(`❌ UniqueID=${uniqueId} 조회 최종 실패 → 새로 생성 시도(중복 가능성 有)`);
        return undefined; // 신뢰 안됨 → 아래에서 신규 생성 경로로
      }
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ───────────── Main upsert

export async function upsertPost(post) {
  const blogId = String(post.blogId || "").trim();
  const postId = String(post.postId || "").trim();
  const group = (post.group || "").trim();

  // UniqueID 구성
  const uniqueId =
    (blogId && postId) ? `${blogId}_${postId}` :
    postId || null;

  if (!uniqueId) {
    console.warn("⚠️ UniqueID 없음, 스킵:", post.title);
    return;
  }

  const existing = await findExisting(uniqueId);

  const iso = normalizeDate(post.pubdate);
  const { year, month, quarter } = calcYMQ(iso);
  const createdAt = new Date().toISOString();

  const props = {
    // 기본 정보
    "Title": { type: "title", title: [{ text: { content: post.title || "" } }] },
    "URL":   { type: "url", url: post.link || null },
    "Nickname": { type: "rich_text", rich_text: [{ text: { content: post.nickname || "" } }] },
    "Description": {
      type: "rich_text",
      rich_text: [{ text: { content: (post.description || "").slice(0, 1800) } }]
    },

    // 날짜 관련
    ...(iso && { "Date": { type: "date", date: { start: iso } } }),
    "CreatedAt": { type: "date", date: { start: createdAt } },

    // 식별 / 메타
    "UniqueID": { type: "rich_text", rich_text: [{ text: { content: uniqueId } }] },
    ...(blogId && { "ID": { type: "rich_text", rich_text: [{ text: { content: blogId } }] } }),

    // 그룹
    ...(group && { "Group": { type: "rich_text", rich_text: [{ text: { content: group } }] } }),

    // 파생 메타
    ...(year && { "Year": { type: "rich_text", rich_text: [{ text: { content: year } }] } }),
    ...(month && { "Month": { type: "rich_text", rich_text: [{ text: { content: month } }] } }),
    ...(quarter && { "Quarter": { type: "rich_text", rich_text: [{ text: { content
