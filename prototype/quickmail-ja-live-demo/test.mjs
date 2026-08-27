import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (error) {
  throw new Error("Playwright is required. Run with NODE_PATH pointing to a node_modules directory that contains playwright.", { cause:error });
}

const directory = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(directory,"index.html");
const headersPath = path.join(directory,"_headers");
const html = fs.readFileSync(htmlPath,"utf8");
const headers = fs.readFileSync(headersPath,"utf8");

assert.equal((html.match(/<script(?:\s|>)/giu) || []).length,1,"HTML must contain one script start tag");
assert.equal((html.match(/<\/script/giu) || []).length,1,"HTML must contain one intended script close boundary");
const script = html.match(/<script>([\s\S]*?)<\/script>/iu)?.[1];
assert.ok(script,"inline script must be extractable");
assert.doesNotThrow(() => new Function(script),"inline script must parse as JavaScript");

const hash = "sha256-" + crypto.createHash("sha256").update(script).digest("base64");
assert.ok(html.includes("script-src '" + hash + "'"),"HTML CSP hash must match the inline script");
assert.ok(headers.includes("script-src '" + hash + "'"),"deployed CSP hash must match the inline script");

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  chromium.executablePath()
].filter(Boolean);
const executablePath = chromeCandidates.find(candidate => fs.existsSync(candidate));
assert.ok(executablePath,"Chrome or Chromium executable must be available");

const browser = await chromium.launch({headless:true,executablePath});
const page = await browser.newPage({viewport:{width:1280,height:720}});
const pageErrors = [];
page.on("pageerror",error => pageErrors.push(error.message));

try {
  await page.goto(pathToFileURL(htmlPath).href);
  await page.waitForSelector(".app");

  const parsed = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    const rawSourceNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest("script,style")) continue;
      if (/function reducer|runSensitiveGuardCanary|const AI_PROVIDERS/u.test(node.nodeValue || "")) {
        rawSourceNodes.push((node.nodeValue || "").slice(0,80));
      }
    }
    return {
      appRendered:Boolean(document.querySelector(".app")),
      scriptElements:document.scripts.length,
      rawSourceNodes,
      modalBackdrops:document.querySelectorAll(".modal-backdrop").length
    };
  });
  assert.deepEqual(parsed,{appRendered:true,scriptElements:1,rawSourceNodes:[],modalBackdrops:0});
  assert.match(await page.textContent(".demo-banner"),/外部サービスへの移動を要求します/u);

  await page.click('[data-action="navigate"][data-view="settings"]');
  for (const layout of ["gmail","outlook","thunderbird"]) {
    await page.click('[data-action="layout"][data-layout="' + layout + '"]');
    assert.equal(await page.getAttribute(".app","data-layout"),layout,layout + " layout must render");
  }

  await page.click('[data-action="folder-modal"]');
  assert.equal(await page.locator(".modal-backdrop").count(),1,"folder modal must be singular");
  await page.evaluate(() => document.querySelector('[data-action="folder-menu"]').click());
  assert.equal(await page.locator(".modal-backdrop").count(),1,"opening another modal must replace the first");
  await page.click('[data-action="folder-delete-request"]');
  assert.equal(await page.locator(".modal-backdrop").count(),1,"nested modal flow must not stack backdrops");
  await page.click('[data-action="modal-close"]');

  const allowlistChecks = await page.evaluate(() => ({
    exactChatGPT:isAllowedProviderUrl("ChatGPT",providerUrl("ChatGPT","test")),
    exactClaude:isAllowedProviderUrl("Claude",providerUrl("Claude","test")),
    exactGemini:isAllowedProviderUrl("Gemini",providerUrl("Gemini","test")),
    lookalikeOrigin:isAllowedProviderUrl("ChatGPT","https://chatgpt.com.evil.invalid/?q=test"),
    wrongPath:isAllowedProviderUrl("Claude","https://claude.ai/new/extra?q=test"),
    extraParameter:isAllowedProviderUrl("ChatGPT","https://chatgpt.com/?q=test&next=https://evil.invalid"),
    fragment:isAllowedProviderUrl("Gemini","https://gemini.google.com/app#prompt")
  }));
  assert.deepEqual(allowlistChecks,{
    exactChatGPT:true,
    exactClaude:true,
    exactGemini:true,
    lookalikeOrigin:false,
    wrongPath:false,
    extraParameter:false,
    fragment:false
  },"provider allowlist must match exact HTTPS origin, path, query shape, and no fragment");

  await page.evaluate(() => {
    window.__quickmailAudit = {navigations:[],copies:[]};
    HTMLAnchorElement.prototype.click = function() {
      window.__quickmailAudit.navigations.push({
        href:this.href,
        target:this.target,
        rel:this.rel,
        referrerPolicy:this.referrerPolicy
      });
    };
    Object.defineProperty(navigator,"clipboard",{
      configurable:true,
      value:{writeText(value) {
        window.__quickmailAudit.copies.push(String(value));
        return Promise.resolve();
      }}
    });
  });

  const unsafeQuestions = [
    "<scr" + "ipt>alert(1)</scr" + "ipt>",
    "contact@example.com",
    "APIキー：whsec_reviewcanary12345678",
    "確認" + String.fromCodePoint(0x202e) + "txt"
  ];
  for (const value of unsafeQuestions) {
    await page.fill("#ai-question",value);
    await page.click('[data-action="ai-handoff"][data-provider="ChatGPT"]');
  }
  let audit = await page.evaluate(() => window.__quickmailAudit);
  assert.deepEqual(audit,{navigations:[],copies:[]},"unsafe input must cause zero navigation and zero clipboard writes");

  await page.fill("#ai-question","CloudflareとResendの設定方法を教えてください");
  for (const provider of ["ChatGPT","Claude","Gemini"]) {
    await page.click('[data-action="ai-handoff"][data-provider="' + provider + '"]');
  }
  await page.waitForFunction(() => window.__quickmailAudit.copies.length === 3);
  audit = await page.evaluate(() => window.__quickmailAudit);
  assert.equal(audit.navigations.length,3,"normal input must request exactly three provider launches");
  assert.equal(audit.copies.length,3,"normal input must copy once per provider");

  const expected = [
    {origin:"https://chatgpt.com",pathname:"/",query:true},
    {origin:"https://claude.ai",pathname:"/new",query:true},
    {origin:"https://gemini.google.com",pathname:"/app",query:false}
  ];
  audit.navigations.forEach((navigation,index) => {
    const url = new URL(navigation.href);
    const allowed = expected[index];
    assert.equal(url.protocol,"https:");
    assert.equal(url.origin,allowed.origin);
    assert.equal(url.pathname,allowed.pathname);
    assert.equal(url.hash,"");
    assert.deepEqual([...url.searchParams.keys()],allowed.query ? ["q"] : []);
    assert.equal(navigation.target,"_blank");
    assert.equal(navigation.rel,"noopener noreferrer");
    assert.equal(navigation.referrerPolicy,"no-referrer");
  });

  assert.deepEqual(pageErrors,[],"browser must not report page errors");
  console.log(JSON.stringify({
    status:"PASS",
    hash,
    parsed,
    layouts:["gmail","outlook","thunderbird"],
    modalBackdropMax:1,
    unsafeNavigationCount:0,
    unsafeClipboardCount:0,
    allowedProviderLaunches:audit.navigations.map(item => new URL(item.href).origin)
  },null,2));
} finally {
  await browser.close();
}
