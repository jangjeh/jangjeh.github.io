// landing worker: 정적 자산 + 익명 요청함 API
// - POST /api/request  : 요청 접수 (KV 저장, IP 등 개인정보 미저장)
// - GET  /api/admin    : 접수 내역 열람 (ADMIN_KEY secret 필요)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// 재전송 남용 방지용 임시 키 — IP는 해시로만, 30초 뒤 자동 삭제 (내용과 연결되지 않음)
async function rateKey(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("reqbox|" + ip));
  return "rl:" + [...new Uint8Array(digest)].slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/request") {
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);

      let text = "";
      try {
        const body = await request.json();
        text = String(body.text || "").trim();
      } catch {
        return json({ ok: false, error: "bad json" }, 400);
      }
      if (!text) return json({ ok: false, error: "empty" }, 400);
      if (text.length > 4000) return json({ ok: false, error: "too long (max 4000)" }, 400);

      const rl = await rateKey(request);
      if (await env.REQUESTS.get(rl)) return json({ ok: false, error: "rate" }, 429);
      await env.REQUESTS.put(rl, "1", { expirationTtl: 30 });

      const key = "req:" + new Date().toISOString() + ":" + crypto.randomUUID().slice(0, 8);
      await env.REQUESTS.put(key, JSON.stringify({ text, ts: Date.now() }));
      return json({ ok: true });
    }

    if (url.pathname === "/api/admin") {
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) {
        return new Response("Not found", { status: 404 });
      }
      const list = await env.REQUESTS.list({ prefix: "req:", limit: 1000 });
      const keys = list.keys.map((k) => k.name).sort().reverse();
      const items = [];
      for (const name of keys) {
        try {
          const v = JSON.parse(await env.REQUESTS.get(name));
          if (v && v.text) items.push({ name, ...v });
        } catch { /* skip broken entry */ }
      }
      const rows = items.map((it) => {
        const t = new Date(it.ts).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
        return `<li><time>${esc(t)}</time><pre>${esc(it.text)}</pre></li>`;
      }).join("\n");
      const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>요청함 관리</title>
<meta name="robots" content="noindex,nofollow">
<style>
 body{margin:0;background:#F5F7F8;color:#0A2233;font-family:-apple-system,"Segoe UI","Malgun Gothic",sans-serif;}
 .wrap{max-width:760px;margin:0 auto;padding:32px 20px 64px;}
 h1{font-size:18px;} .n{color:#5B7183;font-size:13px;}
 ul{list-style:none;padding:0;} li{background:#fff;border:1px solid #DCE3E7;border-radius:10px;padding:14px 16px;margin:10px 0;}
 time{font-size:12px;color:#5B7183;} pre{margin:8px 0 0;white-space:pre-wrap;word-break:break-word;font:inherit;}
</style></head><body><div class="wrap">
<h1>익명 요청함</h1><p class="n">${items.length}건 · 최신순 · Asia/Seoul</p>
<ul>${rows || "<li><pre>아직 접수된 요청이 없습니다.</pre></li>"}</ul>
</div></body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not found", { status: 404 });
  },
};
