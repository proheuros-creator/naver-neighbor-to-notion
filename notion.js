/**
 * notion.js
 * ───────────────────────────────────────────────
 * 🧩 네이버 이웃새글 → Notion DB 업서트 모듈
 *
 * 규칙:
 *  - UniqueID = blogId_postId (blogId 없으면 postId 단독)
 *  - BlogID (Rich text)에 blogId 저장
 *  - Group (multi-select)에 groupNames 저장
 *      - "A"           → [A]
 *      - "A,B,C"       → [A, B, C]
 *  - CSV에 groupNames 있으면 → 그 값으로 Group "덮어쓰기"
 *  - CSV에 groupNames 없으면 → 기존 Group 유지
 *  - (Title, URL, Category, Group 모두 동일하면 update 스킵)
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

  if (typeof raw === "number") {
    return new Date(raw).toISOString();
  }

  const s = String(raw).trim();

  // 13자리 timestamp (ms)
  if (/^\d{13}$/.test(s)) {
    return new Date(Number(s)).toISOString();
  }

  // 10자리 timestamp (sec)
  if (/^\d{10}$/.test(s)) {
    return new Date(Number(s) * 1000).toISOString();
  }

  // "YYYY.MM.DD", "YYYY/MM/DD", "YYYY년 MM월 DD일" 등
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
  if (!isoString) {
    return { year: "", yearMonth: "", quarter: "" };
  }

  const d = new Date(isoString);
  if (isNaN(d.getTime())) {
    return { year: "", yearMonth: "", quarter: "" };
  }

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

function buildGroupMultiSelect(names) {
  if (!names || names.length === 0) return null;
  return names.map((name) => ({ name }));
}

function getExistingGroupNames(page) {
  const multi = page?.properties?.Group?.multi_select || [];
  return multi.map((o) => o.name).filter(Boolean).sort();
}

/**
 * CSV groupNames 있으면: 그 값으로 덮어씀
 * CSV groupNames 없으면: 기존 값 유지
 */
function resolveTargetGroupNames(fromCsv, existingNames) {
  const csvNames = parseGroupNames(fromCsv);
  if (csvNames.length > 0) return csvNames;
  return existingNames.slice().sort();
}

// ───────────────────────────────────────────────
// upsertPost
// ───────────────────────────────────────────────

/**
 * post:
 *  {
 *    title,
 *    link,
 *    nickname,
 *    pubdate,
 *    description,
 *    blogId,
 *    postId,
 *    groupName, // CSV groupNames 문자열 ("A" 또는 "A,B,C")
 *  }
 */
export async function upsertPost(post) {
  const blogId = post.blogId ? String(post.blogId) : "";
  const postId = post.postId ? String(post.postId) : "";
  const groupNamesFromCsv = post.groupName || "";

  // UniqueID 생성
  const uniqueId =
    blogId && postId ? `${blogId}_${postId}` : postId || null;

  if (!uniqueId) {
    console.warn("⚠️ UniqueID 없음, 스킵:", post.title);
    return;
  }

  // 기존 페이지 조회
  const existing = await findExistingPageWithRetry(uniqueId);
  if (existing === undefined) {
    console.warn(
      `⚠️ [${uniqueId}] 조회 최종 실패 → 새 페이지 생성 시도 (중복 가능성 있음)`
    );
  }

  const originalDate = normalizeNaverDate(post.pubdate);
  const createdAt = new Date().toISOString();
  const { year, yearMonth, quarter } =
    extractYearMonthQuarter(originalDate);

  // 공통 속성(신규/업데이트 공용)
  const baseProperties = {
    Title: {
      title: [
        {
          text: { content: post.title || "(제목 없음)" },
        },
      ],
    },
    URL: {
      url: post.link || null,
    },
    Nickname: {
      rich_text: [
        {
          text: { content: post.nickname || "" },
        },
      ],
    },
    ...(originalDate && {
      "원본 날짜": {
        date: { start: originalDate },
      },
    }),
    "생성 일시": {
      date: { start: createdAt },
    },
    Category: {
      rich_text: [
        {
          text: { content: post.category || "" },
        },
      ],
    },
    Description: {
      rich_text: [
        {
          text: {
            content: (post.description || "").slice(0, 1800),
          },
        },
      ],
    },
    UniqueID: {
      rich_text: [
        {
          text: { content: uniqueId },
        },
      ],
    },
    ...(blogId && {
      BlogID: {
        rich_text: [
          {
            text: { content: blogId },
          },
        ],
      },
    }),
    ...(year && {
      연도: {
        rich_text: [
          {
            text: { content: year },
          },
        ],
      },
    }),
    ...(yearMonth && {
      연월: {
        rich_text: [
          {
            text: { content: yearMonth },
          },
        ],
      },
    }),
    ...(quarter && {
      분기: {
        rich_text: [
          {
            text: { content: quarter },
          },
        ],
      },
    }),
  };

  // 1️⃣ 신규 페이지 (existing 없음)
  if (!existing) {
    const csvNames = parseGroupNames(groupNamesFromCsv);
    const groupMulti = buildGroupMultiSelect(csvNames);

    const properties = {
      ...baseProperties,
      ...(groupMulti && {
        Group: { multi_select: groupMulti },
      }),
    };

    await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    });

    console.log(`🆕 새 글 추가: ${post.title}`);
    return;
  }

  // 2️⃣ 기존 페이지 업데이트
  const old = existing.properties;

  const oldTitle =
    old.Title?.title?.[0]?.plain_text || "";
  const oldUrl = old.URL?.url || "";
  const oldCat =
    old.Category?.rich_text?.[0]?.plain_text || "";
  const oldGroupNames = getExistingGroupNames(existing);

  const targetGroupNames = resolveTargetGroupNames(
    groupNamesFromCsv,
    oldGroupNames
  );

  const nextTitle = post.title || "(제목 없음)";
  const nextUrl = post.link || null;
  const nextCat = post.category || "";

  const isSame =
    oldTitle === nextTitle &&
    oldUrl === nextUrl &&
    oldCat === nextCat &&
    oldGroupNames.join(",") === targetGroupNames.join(",");

  if (isSame) {
    console.log(`⏩ 변경 없음 (스킵): ${post.title}`);
    return;
  }

  const updateProperties = {
    ...baseProperties,
  };

  const groupMulti = buildGroupMultiSelect(targetGroupNames);
  if (groupMulti) {
    updateProperties.Group = {
      multi_select: groupMulti,
    };
  } else {
    // CSV에도 없고 기존에도 없으면 빈 배열
    updateProperties.Group = { multi_select: [] };
  }

  await notion.pages.update({
    page_id: existing.id,
    properties: updateProperties,
  });

  console.log(`🔄 업데이트: ${post.title}`);
}
