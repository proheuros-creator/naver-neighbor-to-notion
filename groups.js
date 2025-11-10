/**
 * groups.js
 * ───────────────────────────────────────────────
 * 이웃그룹 목록 정의 파일
 * groupId와 그룹 이름을 매핑합니다.
 * groupId=0(전체이웃)은 제외됩니다.
 */

export const GROUPS = [
  { id: 4, name: "증권사" },  
  { id: 8, name: "투자(Youtube)" }, 
  { id: 5, name: "중국투자" },  
  { id: 3, name: "미국투자" }, 
  { id: 9, name: "에코" },
  { id: 2, name: "투자" }
  { id: 13, name: "투자(Diligent)" },
  { id: 14, name: "투자(정리)" },  
  { id: 7, name: "투자(insight)" },
  { id: 1, name: "투자(daily)" },
  // ✅ 새 그룹을 추가하려면 아래처럼 한 줄만 추가하세요.
  // { id: 15, name: "새그룹" },
];
