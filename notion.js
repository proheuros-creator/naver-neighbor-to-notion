/**
 * notion.js
 * ───────────────────────────────────────────────
 * 🧩 네이버 이웃새글 → Notion DB 업서트 모듈 (최종 버전)
 *
 * 규칙:
 *  - UniqueID = {blogId}_{postId}   (index.js에서 URL 기준으로 확정된 값 사용)
 *  - BlogID (Rich text) = blogId
 *  - Group (multi-select):
 *      - post.groupName (CSV groupNames: "A" 또는 "A,B,C")를 분해해 설정
 *      - CSV에 groupNames 있으면 → 그 값으로 Group 덮어쓰기
 *      - CSV에 groupNames 없으면 → 기존 Group 유지
 *  - Title / URL / Category / Group 모두 동일하면 update 스킵
 *  - Notion API 에러 (internal_server_error, rate_limited 등)는 재시도
 */

import { Client } from "@notionhq/client";

// [수정] 타임아웃 시간을 2분(120,000ms)으로 설정하여 쉽게 끊기지 않도록 함
const notion = new Client({ 
  auth: process.env.NOTION_API_KEY,
  timeoutMs: 120000,
});
const databaseId = process.env.NOTION_DATABASE_ID;

if (!databaseId) {
  console.error("❌ NOTION_DATABASE_ID 가 설정되어 있지 않습니다.");
  process.exit(1);
}

// ───────────────────────────────────────────────
// 🕒 날짜 유틸
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

  // "YYYY.MM.DD", "YYYY/MM/DD", "YYYY년 MM월 DD일" 등 대충 포맷 정규화
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
// ⏳ 공통 Retry 유틸
// ───────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNotionError(err) {
  const code = err.code || "";
  const msg = err.message || "";
  const status = err.status; // HTTP Status Code 확인

  // [수정] 500번대 에러(500, 502, 503, 504 등)는 서버 문제이므로 무조건 재시도
  if (typeof status === 'number' && status >= 500) {
    return true;
  }

  return (
    code === "notionhq_client_request_timeout" ||
    code === "notionhq_client_response_error" || // [수정] 응답 에러(504 등) 코드 추가
    code === "internal_server_error" ||
    code === "rate_limited" ||
    code === "service_unavailable" ||
    msg.includes("Connection terminated unexpectedly") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("timeout") ||
    msg.includes("504") || // [수정] 504 Gateway Timeout 명시
    msg.includes("502")    // [수정] 502 Bad Gateway 명시
  );
}

// [수정] maxRetries 기본값 3 -> 5회로 증가
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

      // [수정] 지수 백오프 적용 (1초, 2초, 4초, 8초, 16초...)
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
// 🔍 UniqueID 기반 페이지 조회 (재시도 포함)
// ───────────────────────────────────────────────

// [수정] retries 기본값 3 -> 5회로 증가
async function findExistingPageWithRetry(uniqueId, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await notion.databases.query({
        database_id: databaseId,
        filter: {
          property: "UniqueID",
          rich_text: { equals: uniqueId },
        },
      });

      return res.results?.[0] || null;
    } catch (err) {
      const retryable = isRetryableNotionError(err);
      const msg = err.code || err.message || String(err);

      console.warn(
        `⚠️ Notion 조회 실패 (${attempt}/${retries}) [${uniqueId}]: ${msg}`
      );

      if (!retryable || attempt === retries) {
        console.error(
          `❌ Notion 조회 최종 실패: ${uniqueId} (중복 가능성 감수하고 새 페이지 생성 예정)`
        );
        return undefined; // upsertPost 쪽에서 새로 생성 시도
      }

      // [수정] 지수 백오프 적용 (1초, 2초, 4초...)
      const delay = 1000 * Math.pow(2, attempt - 1);
      console.log(`⏳ ${delay}ms 후 재시도...`);
      await sleep(delay);
    }
  }
}

// ───────────────────────────────────────────────
// 🏷 Group (multi-select) 유틸
// ───────────────────────────────────────────────

/**
 * "A,B,C" → ["A", "B", "C"]
 */
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
 * CSV에 groupNames 있으면 그 값으로 덮어쓰기,
 * 없으면 기존 Group 값 유지.
 */
function resolveTargetGroupNames(fromCsv, existingNames) {
  const csvNames = parseGroupNames(fromCsv);
  if (csvNames.length > 0) return csvNames;
  return existingNames.slice().sort();
}

// ───────────────────────────────────────────────
// 💾 upsertPost
// ───────────────────────────────────────────────

/**
 * index.js 에서 넘어오는 post 포맷:
 * {
 *   title,
 *   link,
 *   nickname,
 *   pubdate,
 *   description,
 *   blogId,    // URL에서 추출된 진짜 blogId
 *   postId,    // URL에서 추출된 진짜 postId
 *   groupName, // CSV groupNames 문자열 ("A" 또는 "A,B,C")
 * }
 */
export async function upsertPost(post) {
  const blogId = post.blogId ? String(post.blogId) : "";
  const postId = post.postId ? String(post.postId) : "";
  const groupNamesFromCsv = post.groupName || "";

  // UniqueID는 URL 기준 blogId/postId 조합
  const uniqueId =
    blogId && postId ? `${blogId}_${postId}` : null;

  if (!uniqueId) {
    console.warn(
      "⚠️ UniqueID 없음 (blogId/postId 부족), 스킵:",
      post.title
    );
    return;
  }

  // 1️⃣ 기존 페이지 조회
  const existing = await findExistingPageWithRetry(uniqueId);
  if (existing === undefined) {
    console.warn(
      `⚠️ [${uniqueId}] 조회 실패 → 중복 가능성 감수하고 새 페이지 생성 시도`
    );
  }

  // 2️⃣ 날짜 관련 처리
  const originalDate = normalizeNaverDate(post.pubdate);
  const createdAt = new Date().toISOString();
  const { year, yearMonth, quarter } =
    extractYearMonthQuarter(originalDate);

  // 3️⃣ 공통 속성 (신규/업데이트 공용)
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
            content: (post.description || "").slice(
              0,
              1800
            ),
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

  // 4️⃣ 신규 페이지 생성
  if (!existing) {
    const csvNames = parseGroupNames(groupNamesFromCsv);
    const groupMulti = buildGroupMultiSelect(csvNames);

    const properties = {
      ...baseProperties,
      ...(groupMulti && {
        Group: { multi_select: groupMulti },
      }),
    };

    await withNotionRetry(
      () =>
        notion.pages.create({
          parent: { database_id: databaseId },
          properties,
        }),
      `페이지 생성 [${post.title}]`
    );

    console.log(`🆕 새 글 추가: ${post.title}`);
    return;
  }

  // 5️⃣ 기존 페이지 업데이트
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
    oldGroupNames.join(",") ===
      targetGroupNames.join(",");

  if (isSame) {
    console.log(`⏩ 변경 없음 (스킵): ${post.title}`);
    return;
  }

  const updateProperties = {
    ...baseProperties,
  };

  const groupMulti =
    buildGroupMultiSelect(targetGroupNames);

  if (groupMulti) {
    updateProperties.Group = {
      multi_select: groupMulti,
    };
  } else {
    // CSV에도 없고 기존에도 없으면 빈 배열
    updateProperties.Group = { multi_select: [] };
  }

  await withNotionRetry(
    () =>
      notion.pages.update({
        page_id: existing.id,
        properties: updateProperties,
      }),
    `페이지 업데이트 [${post.title}]`
  );

  console.log(`🔄 업데이트: ${post.title}`);
}
