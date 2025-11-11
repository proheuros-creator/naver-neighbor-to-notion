// neighbor-activity/index.js

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs").promises;
const { baseId, maxPages, delayMs } = require("./config");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FOLLOWINGS_BASE =
  "https://section.blog.naver.com/connect/ViewMoreFollowings.naver";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * groups.js (ESM) 로드
 * - export const GROUPS = [ { id, name }, ... ]
 * - neighbor-activity 기준 상위 폴더(../groups.js)에 있다고 가정
 */
async function loadGroups() {
  try {
    const mod = await import("../groups.js");
    const arr = Array.isArray(mod.GROUPS) ? mod.GROUPS : [];
    const map = {};
    for (const g of arr) {
      if (!g || g.id == null) continue;
      map[String(g.id)] = g.name || "";
    }
    return { groupList: arr, groupMap: map };
  } catch (e) {
    console.log("⚠️ groups.js 로드 실패 (그룹 정보 없이 진행):", e.message);
    return { groupList: [], groupMap: {} };
  }
}

/**
 * href에서 blogId 추출: https://blog.naver.com/{id}
 */
function extractBlogId(href) {
  if (!href) return null;
  const m = href.match(/^https?:\/\/blog\.naver\.com\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * ViewMoreFollowings HTML에서 이웃 추가
 * - blogId, blogUrl, nickname, groupIds 세팅
 */
function collectFromFollowingsHtml(html, neighborsMap, groupIdOrNull) {
  const $ = cheerio.load(html);

  $("a[href*='blog.naver.com/']").each((_, el) => {
    const href = $(el).attr("href");
    const blogId = extractBlogId(href);
    if (!blogId) return;

    // 링크 텍스트를 닉네임 후보로 사용
    const linkText = ($(el).text() || "").trim();

    if (!neighborsMap.has(blogId)) {
      neighborsMap.set(blogId, {
        blogId,
        blogUrl: `https://blog.naver.com/${blogId}`,
        nickname: linkText || "",
        groupIds: new Set()
      });
    } else {
      const n = neighborsMap.get(blogId);
      if (!n.nickname && linkText) {
        n.nickname = linkText;
      }
    }

    if (groupIdOrNull != null) {
      neighborsMap
        .get(blogId)
        .groupIds.add(String(groupIdOrNull));
    }
  });
}

/**
 * ViewMoreFollowings 페이지 호출
 */
async function fetchFollowingsPage({ page, groupId }) {
  const cookie = process.env.NAVER_COOKIE || "";
  const params = new URLSearchParams();
  params.set("blogId", baseId);
  params.set("currentPage", String(page));
  if (groupId != null) params.set("groupId", String(groupId));

  const url = `${FOLLOWINGS_BASE}?${params.toString()}`;

  const res = await axios.get(url, {
    headers: {
      "User-Agent": UA,
      Cookie: cookie
    }
  });

  return res.data;
}

/**
 * 1단계: 전체 이웃 수집 (groupId 없이)
 */
async function collectAllNeighbors() {
  const neighbors = new Map();

  for (let page = 1; page <= maxPages; page++) {
    console.log(`📥 [ALL] Fetch neighbors page ${page}`);
    let html;
    try {
      html = await fetchFollowingsPage({ page, groupId: null });
    } catch (e) {
      console.warn(`   ⚠️ [ALL] Page ${page} load failed: ${e.message}`);
      break;
    }

    const before = neighbors.size;
    collectFromFollowingsHtml(html, neighbors, null);
    const added = neighbors.size - before;

    console.log(
      `   👥 [ALL] Total: ${neighbors.size} (page ${page}, +${added})`
    );

    if (page > 1 && added === 0) {
      console.log("   ⛔ [ALL] No new neighbors. Stop.");
      break;
    }

    await sleep(delayMs);
  }

  return neighbors;
}

/**
 * 2단계: groups.js 기준 그룹 멤버십 채우기
 */
async function enrichWithGroups(neighbors, groupList) {
  if (!groupList.length) {
    console.log("⚠️ 그룹 정의가 없어 groupId 매핑은 생략합니다.");
    return;
  }

  console.log(
    `🔎 그룹 멤버십 스캔 (GROUPS: ${groupList
      .map((g) => `${g.id}:${g.name}`)
      .join(", ")})`
  );

  for (const g of groupList) {
    const gid = g.id;
    for (let page = 1; page <= maxPages; page++) {
      console.log(`📥 [GROUP ${gid}] ${g.name} - page ${page}`);

      let html;
      try {
        html = await fetchFollowingsPage({ page, groupId: gid });
      } catch (e) {
        console.warn(
          `   ⚠️ [GROUP ${gid}] Page ${page} load failed: ${e.message}`
        );
        break;
      }

      const before = countGroupMembers(neighbors, gid);
      collectFromFollowingsHtml(html, neighbors, gid);
      const after = countGroupMembers(neighbors, gid);
      const added = after - before;

      console.log(
        `   👥 [GROUP ${gid}] members: ${after} (page ${page}, +${added})`
      );

      if (page > 1 && added === 0) {
        console.log(`   ⛔ [GROUP ${gid}] No new members. Stop.`);
        break;
      }

      await sleep(delayMs);
    }
  }
}

function countGroupMembers(neighbors, gid) {
  const key = String(gid);
  let cnt = 0;
  for (const n of neighbors.values()) {
    if (n.groupIds.has(key)) cnt++;
  }
  return cnt;
}

/**
 * 주어진 handle이 실제 인플루언서 페이지인지, 그리고 (옵션) 특정 blogId와 연결되는지 확인
 */
async function verifyInfluencerHandle(handle, blogId) {
  const url = `https://in.naver.com/${handle}`;
  try {
    const res = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: (s) => s === 200 || (s >= 300 && s < 400),
      headers: { "User-Agent": UA }
    });

    if (res.status !== 200) return null;

    const body =
      typeof res.data === "string"
        ? res.data
        : (res.data || "").toString();

    const looksInfluencer =
      body.includes("인플루언서") ||
      body.toLowerCase().includes("influencer") ||
      body.includes("in.naver.com");

    if (!looksInfluencer) return null;

    // blogId가 주어지면, 그 블로그와 연결 흔적이 있는지 확인
    if (blogId) {
      const hasBlogLink =
        body.includes(`blog.naver.com/${blogId}`) ||
        body.includes(`"${blogId}"`) ||
        body.includes(`'${blogId}'`);
      if (!hasBlogLink && handle !== blogId) {
        // handle == blogId 인 케이스는 허용, 아니면 연결 없으면 패스
        return null;
      }
    }

    return { handle, url };
  } catch (e) {
    return null;
  }
}

/**
 * 닉네임으로 네이버 통합검색 → 인플 후보 handle 찾기
 * - "네이버 인플루언서" + in.naver.com/{handle} 있는 카드에서 nickname과 함께 있는 것 찾기
 * - 찾으면 handle 검증(verifyInfluencerHandle)까지 수행
 */
async function findInfluencerHandleByNickname(nickname, blogId) {
  if (!nickname) return null;

  const q = encodeURIComponent(nickname);
  const searchUrl = `https://search.naver.com/search.naver?query=${q}`;

  try {
    const res = await axios.get(searchUrl, {
      headers: { "User-Agent": UA }
    });

    const html =
      typeof res.data === "string"
        ? res.data
        : (res.data || "").toString();
    const $ = cheerio.load(html);

    let candidateHandle = null;

    $("a[href*='in.naver.com/']").each((_, el) => {
      if (candidateHandle) return;

      const href = $(el).attr("href") || "";
      const m = href.match(/in\.naver\.com\/([^\/\?\s]+)/);
      if (!m || !m[1]) return;

      const handle = m[1].trim();
      if (!handle) return;

      // 주변 블럭 텍스트에 "네이버 인플루언서"와 닉네임이 같이 있는지 확인
      const $block = $(el).closest("div, li, article, section");
      const text = ($block.text() || "").trim();

      if (
        text.includes("네이버 인플루언서") &&
        text.includes(nickname)
      ) {
        candidateHandle = handle;
      }
    });

    if (!candidateHandle) return null;

    const verified = await verifyInfluencerHandle(candidateHandle, blogId);
    return verified ? verified.handle : null;
  } catch (e) {
    return null;
  }
}

/**
 * blogId + nickname 기준 인플루언서 여부 판별
 *
 * 1) in.naver.com/{blogId} 직접 확인 (handle == blogId)
 * 2) 닉네임으로 네이버 검색 → 인플 후보 handle 찾기 → 그 handle 페이지에서 blogId 연결 확인
 *    (막히거나 구조 달라서 실패하면 그냥 N 처리)
 */
async function detectInfluencerForBlog(blogId, nickname) {
  // 1) blogId와 handle이 동일한 경우
  const direct = await verifyInfluencerHandle(blogId, blogId);
  if (direct) {
    return {
      isInfluencer: "Y",
      influencerId: direct.handle,
      influencerUrl: direct.url
    };
  }

  // 2) 닉네임 기반 매칭 시도 (실패해도 N으로 처리)
  const handleFromNickname = await findInfluencerHandleByNickname(
    nickname,
    blogId
  );
  if (handleFromNickname) {
    const verified = await verifyInfluencerHandle(handleFromNickname, blogId);
    if (verified) {
      return {
        isInfluencer: "Y",
        influencerId: verified.handle,
        influencerUrl: verified.url
      };
    }
  }

  // 자동으로 확신할 수 없으면 보수적으로 N
  return {
    isInfluencer: "N",
    influencerId: "",
    influencerUrl: ""
  };
}

/**
 * 메인
 */
async function main() {
  try {
    const { groupList, groupMap } = await loadGroups();

    // 1) 전체 이웃
    const neighborsMap = await collectAllNeighbors();

    // 2) 그룹 멤버십
    await enrichWithGroups(neighborsMap, groupList);

    // 3) 인플루언서 여부 + 인플루언서 ID/URL
    const neighbors = Array.from(neighborsMap.values());
    for (let i = 0; i < neighbors.length; i++) {
      const n = neighbors[i];
      console.log(
        `⭐ [${i + 1}/${neighbors.length}] Detect influencer for: ${n.blogId} (${n.nickname || ""})`
      );
      const info = await detectInfluencerForBlog(n.blogId, n.nickname);
      n.isInfluencer = info.isInfluencer;
      n.influencerId = info.influencerId;
      n.influencerUrl = info.influencerUrl;
      await sleep(300);
    }

    // 4) CSV 생성
    const header =
      "blogId,blogUrl,nickname,groupIds,groupNames,isInfluencer,influencerId,influencerUrl\n";

    const lines = neighbors.map((n) => {
      const gids = Array.from(n.groupIds || []);
      const gnames = gids
        .map((id) => groupMap[id] || "")
        .filter(Boolean)
        .join("|");

      return [
        n.blogId,
        n.blogUrl,
        n.nickname || "",
        gids.join("|"),
        gnames,
        n.isInfluencer || "N",
        n.influencerId || "",
        n.influencerUrl || ""
      ]
        .map((v) =>
          v != null ? String(v).replace(/"/g, '""') : ""
        )
        .map((v) => `"${v}"`)
        .join(",");
    });

    const csv = header + lines.join("\n");
    await fs.writeFile(
      "neighbor-followings-result.csv",
      csv,
      "utf8"
    );
    console.log("✅ Done. neighbor-followings-result.csv 생성 완료");
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  }
}

main();
