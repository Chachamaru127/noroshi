import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

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
  assert.equal(await page.locator('[data-structure="gmail-single-list"]').count(),1,"Gmail-style must be one airy list");
  assert.equal(await page.locator(".outlook-preview-pane,.thunderbird-columns").count(),0,"Gmail-style must not expose preview or table panes");

  await page.click('[data-action="navigate"][data-view="settings"]');
  assert.deepEqual(await page.locator('[data-action="layout"]').allTextContents(),["Gmail風","Outlook風","Thunderbird風"]);
  const desktopStructures = {};
  for (const layout of ["gmail","outlook","thunderbird"]) {
    await page.click('[data-action="layout"][data-layout="' + layout + '"]');
    assert.equal(await page.getAttribute(".app","data-layout"),layout,layout + " layout must render");
    await page.click('[data-action="navigate"][data-view="inbox"]');
    desktopStructures[layout] = await page.evaluate(() => ({
      gmail:document.querySelectorAll('[data-structure="gmail-single-list"]').length,
      outlook:document.querySelectorAll('[data-structure="outlook-three-pane"]').length,
      listPane:document.querySelectorAll('.outlook-list-pane[data-pane="message-list"]').length,
      readingPane:document.querySelectorAll('.outlook-preview-pane[data-pane="reading"]').length,
      thunderbird:document.querySelectorAll('[data-structure="thunderbird-table"]').length,
      folderTree:document.querySelectorAll(".sidebar .folder-row").length,
      columnHeader:document.querySelectorAll(".thunderbird-columns").length
    }));
    if (layout !== "thunderbird") await page.click('[data-action="navigate"][data-view="settings"]');
  }
  assert.deepEqual(desktopStructures.gmail,{gmail:1,outlook:0,listPane:0,readingPane:0,thunderbird:0,folderTree:2,columnHeader:0});
  assert.deepEqual(desktopStructures.outlook,{gmail:0,outlook:1,listPane:1,readingPane:1,thunderbird:0,folderTree:2,columnHeader:0});
  assert.deepEqual(desktopStructures.thunderbird,{gmail:0,outlook:0,listPane:0,readingPane:0,thunderbird:1,folderTree:2,columnHeader:1});

  await page.evaluate(() => dispatch({type:"THEME",value:"dark"}));
  assert.equal(await page.getAttribute("html","data-theme"),"dark","dark mode must render with the selected layout");
  await page.evaluate(() => dispatch({type:"THEME",value:"light"}));

  const folderTrigger = page.locator('[data-action="folder-modal"]');
  await folderTrigger.focus();
  await folderTrigger.click();
  assert.equal(await page.locator(".modal-backdrop").count(),1,"folder modal must be singular");
  const folderDialog = page.getByRole("dialog",{name:"フォルダを追加"});
  assert.equal(await folderDialog.count(),1,"dialog must have an accessible name through aria-labelledby");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("name")),"name","initial focus must move inside the dialog");
  assert.deepEqual(await page.evaluate(() => ({sidebar:document.querySelector(".sidebar").inert,content:document.querySelector(".content-shell").inert})),{sidebar:true,content:true},"background must be inert while a dialog is open");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()),"追加","Shift+Tab from the first item must wrap to the last item");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("name")),"name","Tab from the last item must wrap to the first item");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".modal-backdrop").count(),0,"Escape must close the dialog");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.action),"folder-modal","focus must return to the opening control");

  await page.evaluate(() => document.querySelector('[data-action="folder-menu"]').click());
  assert.equal(await page.locator(".modal-backdrop").count(),1,"opening another modal must replace the first");
  await page.click('[data-action="folder-delete-request"]');
  assert.equal(await page.locator(".modal-backdrop").count(),1,"nested modal flow must not stack backdrops");
  assert.equal(await page.getByRole("dialog",{name:"「アーカイブ」を削除しますか？"}).count(),1);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.action),"folder-menu","focus must restore to the original trigger after a nested modal flow");

  const modalFixtures = [
    {type:"send"},
    {type:"folder"},
    {type:"folder-menu",id:"archive"},
    {type:"folder-delete",id:"archive"},
    {type:"user-edit",id:"u1"},
    {type:"empty-trash"}
  ];
  for (const modal of modalFixtures) {
    const labelled = await page.evaluate(value => {
      dispatch({type:"OPEN_MODAL",modal:value});
      const dialog = document.querySelector('[role="dialog"]');
      const labelId = dialog?.getAttribute("aria-labelledby") || "";
      return Boolean(labelId && document.getElementById(labelId)?.textContent?.trim());
    },modal);
    assert.equal(labelled,true,modal.type + " dialog must have a referenced accessible name");
    await page.evaluate(() => dispatch({type:"CLOSE_MODAL"}));
  }

  await page.setViewportSize({width:390,height:844});
  const mobileGeometry = {};
  for (const layout of ["gmail","outlook","thunderbird"]) {
    await page.evaluate(value => {
      dispatch({type:"NAVIGATE",view:"inbox"});
      dispatch({type:"LAYOUT",value});
      dispatch({type:"THEME",value:"dark"});
    },layout);
    assert.equal(await page.getAttribute("html","data-theme"),"dark");
    mobileGeometry[layout] = await page.evaluate(() => {
      const visible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const rect = element => {
        const value = element.getBoundingClientRect();
        return {left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height};
      };
      const interactive = [...document.querySelectorAll('button,input:not([type="hidden"]),select,textarea,a[href]')].filter(visible);
      const undersized = interactive.filter(element => {
        const target = element.matches('input[type="checkbox"]') ? element.closest(".select-wrap,.select-hit,.acknowledge") || element : element;
        const box = target.getBoundingClientRect();
        return box.width < 43.5 || box.height < 43.5;
      }).map(element => ({tag:element.tagName,action:element.dataset.action || "",label:element.getAttribute("aria-label") || element.textContent.trim().slice(0,30),box:rect(element)}));
      const rowControls = [...document.querySelectorAll(".mail-row:first-child button,.mail-row:first-child input")].filter(visible);
      const overlaps = [];
      for (let i = 0; i < rowControls.length; i += 1) {
        for (let j = i + 1; j < rowControls.length; j += 1) {
          const a = rowControls[i].getBoundingClientRect();
          const b = rowControls[j].getBoundingClientRect();
          const width = Math.min(a.right,b.right) - Math.max(a.left,b.left);
          const height = Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top);
          if (width > 1 && height > 1) overlaps.push([rowControls[i].className,rowControls[j].className]);
        }
      }
      const banner = document.querySelector(".demo-banner").getBoundingClientRect();
      const topbar = document.querySelector(".topbar").getBoundingClientRect();
      const main = document.querySelector("main").getBoundingClientRect();
      return {
        viewport:innerWidth,
        documentWidth:document.documentElement.scrollWidth,
        bodyWidth:document.body.scrollWidth,
        headerOverlap:banner.bottom > topbar.top + 1 || topbar.bottom > main.top + 1,
        rowControlOverlaps:overlaps,
        undersized,
        previewVisible:Boolean(document.querySelector(".outlook-preview-pane") && visible(document.querySelector(".outlook-preview-pane"))),
        columnHeaderVisible:Boolean(document.querySelector(".thunderbird-columns") && visible(document.querySelector(".thunderbird-columns")))
      };
    });
    assert.equal(mobileGeometry[layout].documentWidth,390,layout + " must not overflow the mobile viewport");
    assert.equal(mobileGeometry[layout].bodyWidth,390,layout + " body must not overflow the mobile viewport");
    assert.equal(mobileGeometry[layout].headerOverlap,false,layout + " fixed and flow headers must not overlap");
    assert.deepEqual(mobileGeometry[layout].rowControlOverlaps,[],layout + " row controls must not overlap");
    assert.deepEqual(mobileGeometry[layout].undersized,[],layout + " visible interactive targets must be at least 44px");
    assert.equal(mobileGeometry[layout].previewVisible,false,"Outlook reading pane must collapse on mobile");
    assert.equal(mobileGeometry[layout].columnHeaderVisible,false,"Thunderbird table header must collapse on mobile");
    await page.evaluate(() => dispatch({type:"THEME",value:"light"}));
  }

  const mobileSettingsGeometry = {};
  for (const layout of ["gmail","outlook","thunderbird"]) {
    mobileSettingsGeometry[layout] = {};
    for (const theme of ["light","dark"]) {
      await page.evaluate(({layout,theme}) => {
        dispatch({type:"LAYOUT",value:layout});
        dispatch({type:"THEME",value:theme});
        dispatch({type:"NAVIGATE",view:"settings"});
      },{layout,theme});
      mobileSettingsGeometry[layout][theme] = await page.evaluate(() => {
        const cards = [...document.querySelectorAll(".settings-grid > .card")].map(card => {
          const box = card.getBoundingClientRect();
          return {left:box.left,right:box.right,width:box.width};
        });
        return {
          viewport:innerWidth,
          documentWidth:document.documentElement.scrollWidth,
          bodyWidth:document.body.scrollWidth,
          cards,
          longContent:[...document.querySelectorAll(".ai-disclosure,.prompt-preview")].map(element => element.scrollWidth <= element.clientWidth)
        };
      });
      const geometry = mobileSettingsGeometry[layout][theme];
      assert.ok(geometry.documentWidth <= geometry.viewport,layout + "/" + theme + " settings document must not overflow");
      assert.ok(geometry.bodyWidth <= geometry.viewport,layout + "/" + theme + " settings body must not overflow");
      assert.ok(geometry.cards.every(card => card.left >= 0 && card.right <= geometry.viewport + 0.5 && card.width <= geometry.viewport),layout + "/" + theme + " settings cards must fit the viewport");
      assert.ok(geometry.longContent.every(Boolean),layout + "/" + theme + " prompt and disclosure must wrap within their cards");
    }
  }

  await page.setViewportSize({width:1280,height:720});
  await page.reload();
  await page.click('[data-action="navigate"][data-view="settings"]');

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
    "",
    "確認" + String.fromCodePoint(0x07) + "してください",
    "長".repeat(1601),
    "<scr" + "ipt>alert(1)</scr" + "ipt>",
    "contact@example.com",
    "APIキー：" + ["wh", "sec"].join("") + "_reviewcanary12345678",
    "確認" + String.fromCodePoint(0x202e) + "txt"
  ];
  for (const value of unsafeQuestions) {
    await page.evaluate(question => {
      const input = document.querySelector("#ai-question");
      input.value = question;
      input.dispatchEvent(new Event("input",{bubbles:true}));
    },value);
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
    desktopStructures,
    mobileGeometry,
    mobileSettingsGeometry,
    modalBackdropMax:1,
    unsafeNavigationCount:0,
    unsafeClipboardCount:0,
    allowedProviderLaunches:audit.navigations.map(item => new URL(item.href).origin)
  },null,2));
} finally {
  await browser.close();
}
