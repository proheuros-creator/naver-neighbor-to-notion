/**
 * notion.js
 * ───────────────────────────────────────────────
 * 네이버 이웃새글 → Notion DB 업서트 모듈
 *
 * 규칙:
 *  - UniqueID = {blogId}_{postId}   (index.js에서 URL 기준으로 확정된 값 사용)
 *  - BlogID (Rich text) = blogId
 *  - Group (multi-select):
 *      - post.groupName (CSV groupNames: "A" 또는 "A,B,C")를 분해해 설정
 *      - CSV에 groupNames 있으면 → 그 값으로 Group 덮어쓰기
 *      - CSV에 groupNames 없으면 → 기존 Group 유지
 *  - Title / URL / Category / Group 모두 동일하면 update 스킵
 *  - 시작 시 전체 DB를 캐시해 포스트당 쿼리를 제거 (N+1 해결)
 */

import { Client } from "@notionhq/client";

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
  timeoutMs: 120000,
});
const databaseId = process.env.NOTION_DATABASE_ID;

// UniqueID → { pageId, title, url, category, groupNames[] }
const pageCache = new Map();

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

  if (/^\d{13}$/.test(s)) {
    return new Date(Number(s)).toISOString();
  }

  if (/^\d{10}$/.test(s)) {
    return new Date(Number(s) * 1000).toISOString();
  }

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
// 공통 Retry 유틸
// ───────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNotionError(err) {
  const code = err.code || "";
  const msg = err.message || "";
  const status = err.status;

  if (typeof status === "number" && status >= 500) {
    return true;
  }

  return (
    code === "notionhq_client_request_timeout" ||
    code === "notionhq_client_response_error" ||
    code === "internal_server_error" ||
    code === "rate_limited" ||
    code === "service_unavailable" ||
    msg.includes("Connection terminated unexpectedly") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("timeout") ||
    msg.includes("504") ||
    msg.includes("502")
  );
}

async function withNotionRetry(action, desc, maxRetries = 5) {
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      return await action();
    } catch (err) {
      const retryable = isRetryableNotionError(err);

      if (!retryable || attempt >= maxRetries) {
        console.error(
          `❌ Notion ${desc} 실패 (시도 ${attempt}/${maxRetries}):`,
          err.message || err
        );
        throw err;
      }

      const delay = 1000 * Math.pow(2, attempt - 1);
      console.warn(
        `⚠️ Notion ${desc} 오류(${err.status || err.code}), 재시도 예정 (시도 ${attempt}/${maxRetries}, ${delay}ms 대기):`,
        err.message || err
      );
      await sleep(delay);
    }
  }
}

// ───────────────────────────────────────────────
// 전체 DB 캐시 초기화 (시작 시 1회 호출)
// ───────────────────────────────────────────────

export async function initCache() {
  console.log("🗄 Notion DB 전체 캐시 로드 시작...");
  let cursor = undefined;
  let total = 0;

  while (true) {
    let res;
    try {
      res = await withNotionRetry(
        () =>
          notion.databases.query({
            database_id: databaseId,
            page_size: 100,
            ...(cursor && { start_cursor: cursor }),
          }),
        "전체 DB 캐시 로드"
      );
    } catch (err) {
      console.error("❌ 캐시 로드 실패:", err.message);
      break;
    }

    for (const page of res.results) {
      const uid = page.properties?.UniqueID?.rich_text?.[0]?.plain_text;
      if (!uid) continue;
      pageCache.set(uid, {
        pageId: page.id,
        title: page.properties?.Title?.title?.[0]?.plain_text || "",
        url: page.properties?.URL?.url || "",
        category: page.properties?.Category?.rich_text?.[0]?.plain_text || "",
        groupNames: (page.properties?.Group?.multi_select || [])
          .map((o) => o.name)
          .filter(Boolean)
          .sort(),
      });
    }

    total += res.results.length;
    process.stdout.write(`\r  로드 중: ${total}개...`);

    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  console.log(`\n✅ 캐시 로드 완료: ${pageCache.size}개 UniqueID`);
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

function resolveTargetGroupNames(fromCsv, existingNames) {
  const csvNames = parseGroupNames(fromCsv);
  if (csvNames.length > 0) return csvNames;
  return existingNames.slice().sort();
}

// ───────────────────────────────────────────────
// upsertPost
// ───────────────────────────────────────────────

/**
 * index.js 에서 넘어오는 post 포맷:
 * {
 *   title, link, nickname, pubdate, description,
 *   blogId, postId, groupName,
 * }
 */
export async function upsertPost(post) {
  const blogId = post.blogId ? String(post.blogId) : "";
  const postId = post.postId ? String(post.postId) : "";
  const groupNamesFromCsv = post.groupName || "";

  const uniqueId =
    blogId && postId ? `${blogId}_${postId}` : null;

  if (!uniqueId) {
    console.warn("⚠️ UniqueID 없음 (blogId/postId 부족), 스킵:", post.title);
    return;
  }

  // 캐시에서 기존 페이지 조회 (Notion 쿼리 없음)
  const cached = pageCache.get(uniqueId) ?? null;

  const originalDate = normalizeNaverDate(post.pubdate);
  const createdAt = new Date().toISOString();
  const { year, yearMonth, quarter } = extractYearMonthQuarter(originalDate);

  const baseProperties = {
    Title: {
      title: [{ text: { content: post.title || "(제목 없음)" } }],
    },
    URL: { url: post.link || null },
    Nickname: {
      rich_text: [{ text: { content: post.nickname || "" } }],
    },
    ...(originalDate && {
      "원본 날짜": { date: { start: originalDate } },
    }),
    "생성 일시": { date: { start: createdAt } },
    Category: {
      rich_text: [{ text: { content: post.category || "" } }],
    },
    Description: {
      rich_text: [
        { text: { content: (post.description || "").slice(0, 1800) } },
      ],
    },
    UniqueID: {
      rich_text: [{ text: { content: uniqueId } }],
    },
    ...(blogId && {
      BlogID: { rich_text: [{ text: { content: blogId } }] },
    }),
    ...(year && {
      연도: { rich_text: [{ text: { content: year } }] },
    }),
    ...(yearMonth && {
      연월: { rich_text: [{ text: { content: yearMonth } }] },
    }),
    ...(quarter && {
      분기: { rich_text: [{ text: { content: quarter } }] },
    }),
  };

  // 신규 페이지 생성
  if (!cached) {
    const csvNames = parseGroupNames(groupNamesFromCsv);
    const groupMulti = buildGroupMultiSelect(csvNames);

    const properties = {
      ...baseProperties,
      ...(groupMulti && { Group: { multi_select: groupMulti } }),
    };

    await withNotionRetry(
      () => notion.pages.create({ parent: { database_id: databaseId }, properties }),
      `페이지 생성 [${post.title}]`
    );

    // 캐시에 추가
    pageCache.set(uniqueId, {
      pageId: "(pending)",
      title: post.title || "(제목 없음)",
      url: post.link || "",
      category: post.category || "",
      groupNames: csvNames,
    });

    console.log(`🆕 새 글 추가: ${post.title}`);
    return;
  }

  // 기존 페이지 업데이트 여부 확인
  const targetGroupNames = resolveTargetGroupNames(
    groupNamesFromCsv,
    cached.groupNames
  );

  const nextTitle = post.title || "(제목 없음)";
  const nextUrl = post.link || null;
  const nextCat = post.category || "";

  const isSame =
    cached.title === nextTitle &&
    cached.url === (nextUrl || "") &&
    cached.category === nextCat &&
    cached.groupNames.join(",") === targetGroupNames.join(",");

  if (isSame) {
    console.log(`⏩ 변경 없음 (스킵): ${post.title}`);
    return;
  }

  const updateProperties = { ...baseProperties };
  const groupMulti = buildGroupMultiSelect(targetGroupNames);

  if (groupMulti) {
    updateProperties.Group = { multi_select: groupMulti };
  } else {
    updateProperties.Group = { multi_select: [] };
  }

  await withNotionRetry(
    () => notion.pages.update({ page_id: cached.pageId, properties: updateProperties }),
    `페이지 업데이트 [${post.title}]`
  );

  // 캐시 갱신
  pageCache.set(uniqueId, {
    ...cached,
    title: nextTitle,
    url: nextUrl || "",
    category: nextCat,
    groupNames: targetGroupNames,
  });

  console.log(`🔄 업데이트: ${post.title}`);
}
