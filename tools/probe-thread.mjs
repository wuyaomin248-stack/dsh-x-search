import { XClient } from "../lib/xapi.mjs";
const c = new XClient();
const s = await c.search("kiro", { count: 10 });
const first = s.tweets.find((t) => !t.isRT) || s.tweets[0];
console.log("focal:", first.id, "@" + first.user);
const r = await c.thread(first.id);
console.log("[thread]", r.tweets.length, "条");
for (const t of r.tweets.slice(0, 4)) console.log(`  @${t.user} ♥${t.fav} ${t.text.replace(/\n/g," ").slice(0,90)}`);
