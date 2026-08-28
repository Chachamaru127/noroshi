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
assert.doesNotMatch(script,/[✉✎▣▤➤☆★♲⚙⌘▰＋×←→↩☾☼⌕↵••▧◐⇄●○]/u,"common mail actions and navigation must not depend on OS-rendered Unicode glyphs");

const hash = "sha256-" + crypto.createHash("sha256").update(script).digest("base64");
assert.ok(html.includes("script-src '" + hash + "'"),"HTML CSP hash must match the inline script");
assert.ok(headers.includes("script-src '" + hash + "'"),"deployed CSP hash must match the inline script");
assert.match(headers,/X-Robots-Tag: noindex, nofollow/u,"deployed headers must keep the preview out of indexes");
assert.doesNotMatch(html,/<(?:script|link|img|iframe)[^>]+(?:src|href)=["']https?:/iu,"demo must not load external assets");
assert.doesNotMatch(html,/@import\s+url|url\(\s*["']?https?:/iu,"demo must not load external fonts or CSS");
assert.doesNotMatch(script,/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/u,"passive demo runtime must not contain network APIs");
assert.match(html,/connect-src 'none'/u,"passive network must be disabled by CSP");

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
const page = await browser.newPage({viewport:{width:1440,height:900}});
const pageErrors = [];
const passiveRequests = [];
page.on("pageerror",error => pageErrors.push(error.message));
page.on("request",request => passiveRequests.push(request.url()));

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
  const iconContract = await page.evaluate(() => ({
    keys:Object.keys(ICON_PATHS),
    frozen:Object.isFrozen(ICON_PATHS),
    rendered:[...document.querySelectorAll("[data-qm-icon]")].every(element => element.matches('svg[viewBox="0 0 24 24"][aria-hidden="true"]') && element.querySelectorAll("path").length === 1)
  }));
  assert.deepEqual(iconContract,{
    keys:["mail","edit","inbox","draft","send","star","starFill","trash","folder","add","settings","userSettings","search","moon","sun","more","back","close","reply","forward","attachment","key","palette","swap","userAdd","upload","statusOn","statusOff"],
    frozen:true,
    rendered:true
  },"the demo must use one bounded local generic inline SVG icon source");
  assert.match(await page.textContent(".demo-banner"),/非公式.*架空.*送受信しません/u);
  assert.equal(await page.locator(".demo-profile-switcher").count(),1,"the comparison profile selector must remain visible outside settings");
  assert.deepEqual(await page.locator('.demo-profile-switcher [data-action="profile"]').allTextContents(),["Gmail風","Outlook風","Thunderbird風"]);
  assert.equal(await page.locator('[data-profile="calm"][data-structure="list-detail-replacement"]').count(),1,"calm must render its list/detail replacement structure");
  assert.equal(await page.locator('[data-pane="reading"],[data-structure="thread-table"]').count(),0,"calm list view must not expose a reading pane or thread table");

  const profileContract = await page.evaluate(() => ({
    ids:Object.keys(UI_PROFILES),
    entries:Object.values(UI_PROFILES).map(profile => ({
      keys:Object.keys(profile).sort(),
      id:profile.id,
      publicLabel:profile.publicLabel,
      renderer:typeof profile.render
    }))
  }));
  assert.deepEqual(profileContract.ids,["calm","command","classic"]);
  assert.deepEqual(profileContract.entries,[
    {keys:["id","publicLabel","render"],id:"calm",publicLabel:"Gmail風",renderer:"function"},
    {keys:["id","publicLabel","render"],id:"command",publicLabel:"Outlook風",renderer:"function"},
    {keys:["id","publicLabel","render"],id:"classic",publicLabel:"Thunderbird風",renderer:"function"}
  ],"registry entries must remain minimal and contain no layout schema");

  const desktopStructures = {};
  for (const profile of ["calm","command","classic"]) {
    await page.click('.demo-profile-switcher [data-action="profile"][data-profile="' + profile + '"]');
    assert.equal(await page.getAttribute(".app","data-profile"),profile,profile + " profile must render");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.focusKey),"message-m1",profile + " switch must preserve the current logical message focus when the row exists");
    await page.click('[data-action="navigate"][data-view="inbox"]');
    desktopStructures[profile] = await page.evaluate(() => ({
      calm:document.querySelectorAll('[data-profile="calm"][data-structure="list-detail-replacement"]').length,
      command:document.querySelectorAll('[data-profile="command"][data-structure="nav-list-reader"]').length,
      classic:document.querySelectorAll('[data-profile="classic"][data-structure="folder-thread-message"]').length,
      navigation:document.querySelectorAll('[data-pane="navigation"]').length,
      messageList:document.querySelectorAll('[data-pane="message-list"],[data-pane="thread-list"]').length,
      readingPane:document.querySelectorAll('[data-pane="reading"]').length,
      columnHeader:document.querySelectorAll('[data-role="thread-columns"]').length
    }));
  }
  assert.deepEqual(desktopStructures.calm,{calm:1,command:0,classic:0,navigation:0,messageList:1,readingPane:0,columnHeader:0});
  assert.deepEqual(desktopStructures.command,{calm:0,command:1,classic:0,navigation:1,messageList:1,readingPane:1,columnHeader:0});
  assert.deepEqual(desktopStructures.classic,{calm:0,command:0,classic:1,navigation:1,messageList:1,readingPane:1,columnHeader:1});
  assert.equal(await page.locator('[data-profile="classic"] [role="table"],[data-profile="classic"] [role="row"]').count(),0,"classic must not expose incomplete table semantics");

  for (const width of [1440,1024]) {
    await page.setViewportSize({width,height:900});
    for (const profile of ["command","classic"]) {
      await page.reload();
      await page.click('.demo-profile-switcher [data-action="profile"][data-profile="' + profile + '"]');
      await page.click('.mail-row[data-message-id="m2"] .mail-open');
      assert.deepEqual(await page.evaluate(() => ({view:state.view,selectedMessageId:state.selectedMessageId,listAnchorId:state.listAnchorId})),{view:"inbox",selectedMessageId:"m2",listAnchorId:"m2"},width + "/" + profile + " must select m2 without replacing the desktop list");
      assert.equal(await page.locator('[data-pane="message-list"],[data-pane="thread-list"]').count(),1);
      assert.equal(await page.locator('[data-pane="reading"]').count(),1);
      assert.match(await page.textContent('[data-pane="reading"]'),/資料送付のお礼/u);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.focusKey),"message-m2",profile + " must restore focus to m2 after in-place selection");
      await page.click('[data-pane="reading"] [data-action="open-mail-detail"]');
      assert.equal(await page.evaluate(() => state.view),"mail",profile + " reading-pane detail action must open the full message");
      assert.match(await page.textContent("main"),/資料送付のお礼/u);
      await page.click('[data-action="back"]');
      assert.equal(await page.locator('[data-pane="message-list"],[data-pane="thread-list"]').count(),1,profile + " Back must restore its list pane");
      assert.equal(await page.locator('[data-pane="reading"]').count(),1,profile + " Back must restore its reading pane");
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.focusKey),"message-m2",profile + " Back must restore focus to m2");
      if (profile === "command") {
        await page.click('.demo-profile-switcher [data-action="profile"][data-profile="classic"]');
        assert.equal(await page.evaluate(() => document.activeElement?.dataset.focusKey),"message-m2","profile switching must preserve and refocus the non-first logical message");
        assert.match(await page.textContent('[data-pane="reading"]'),/資料送付のお礼/u);
      }
    }
    await page.reload();
    await page.click('.demo-profile-switcher [data-action="profile"][data-profile="calm"]');
    await page.click('.mail-row[data-message-id="m2"] .mail-open');
    assert.deepEqual(await page.evaluate(() => ({view:state.view,selectedMessageId:state.selectedMessageId,listAnchorId:state.listAnchorId})),{view:"mail",selectedMessageId:"m2",listAnchorId:"m2"},width + "/calm must replace the list with detail");
    assert.equal(await page.locator('[data-pane="message-list"],[data-pane="thread-list"]').count(),0);
    await page.click('[data-action="back"]');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.focusKey),"message-m2","calm back must focus and restore the logical m2 list anchor");
  }

  const geometry = {};
  for (const width of [1440,1024]) {
    geometry[width] = {};
    await page.setViewportSize({width,height:900});
    for (const profile of ["calm","command","classic"]) {
      await page.evaluate(value => {
        dispatch({type:"NAVIGATE",view:"inbox"});
        dispatch({type:"PROFILE",value});
      },profile);
      geometry[width][profile] = await page.evaluate(() => {
        const box = selector => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return {width:Math.round(rect.width),height:Math.round(rect.height),display:getComputedStyle(element).display};
        };
        const visible = selector => [...document.querySelectorAll(selector)].filter(element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && rect.width > 0 && rect.height > 0;
        }).length;
        return {
          sidebar:box(".sidebar"),
          row:box(".mail-row"),
          list:box('[data-pane="message-list"],[data-pane="thread-list"]'),
          search:box(".search-wrap"),
          visiblePanes:visible('.sidebar,[data-pane="message-list"],[data-pane="thread-list"],[data-pane="reading"]'),
          optionalColumnDisplay:document.querySelector(".optional-column") ? getComputedStyle(document.querySelector(".optional-column")).display : null,
          overflow:document.documentElement.scrollWidth > innerWidth
        };
      });
    }
  }
  assert.deepEqual({
    calm:{sidebar:geometry[1440].calm.sidebar.width,row:geometry[1440].calm.row.height,panes:geometry[1440].calm.visiblePanes},
    command:{sidebar:geometry[1440].command.sidebar.width,row:geometry[1440].command.row.height,panes:geometry[1440].command.visiblePanes},
    classic:{sidebar:geometry[1440].classic.sidebar.width,row:geometry[1440].classic.row.height,panes:geometry[1440].classic.visiblePanes}
  },{
    calm:{sidebar:256,row:56,panes:2},
    command:{sidebar:240,row:44,panes:3},
    classic:{sidebar:220,row:40,panes:3}
  },"1440px geometry must match the profile documents");
  assert.deepEqual({
    calm:{sidebar:geometry[1024].calm.sidebar.width,row:geometry[1024].calm.row.height,panes:geometry[1024].calm.visiblePanes},
    command:{sidebar:geometry[1024].command.sidebar.width,row:geometry[1024].command.row.height,panes:geometry[1024].command.visiblePanes},
    classic:{sidebar:geometry[1024].classic.sidebar.width,row:geometry[1024].classic.row.height,panes:geometry[1024].classic.visiblePanes,optional:geometry[1024].classic.optionalColumnDisplay}
  },{
    calm:{sidebar:80,row:56,panes:2},
    command:{sidebar:64,row:44,panes:3},
    classic:{sidebar:184,row:40,panes:3,optional:"none"}
  },"1024px geometry must match the compact profile documents");
  assert.equal(geometry[1440].calm.search.width,680,"calm desktop search must use the documented 680px cap");
  assert.ok(geometry[1024].calm.search.width >= 600 && geometry[1024].calm.search.width <= 615,"calm 1024 search must remain the 60vw primary control");
  assert.ok(geometry[1440].command.list.width >= 340 && geometry[1440].command.list.width <= 420,"command desktop list width must stay within its documented clamp");
  assert.ok(geometry[1024].command.list.width >= 320 && geometry[1024].command.list.width <= 380,"command compact list width must stay within its documented clamp");
  assert.ok(geometry[1440].classic.list.width >= 400 && geometry[1440].classic.list.width <= 560,"classic desktop thread width must stay within its documented clamp");
  assert.ok(geometry[1024].classic.list.width >= 360,"classic compact thread width must preserve its documented minimum");
  for (const width of [1440,1024]) {
    for (const profile of ["calm","command","classic"]) {
      assert.equal(geometry[width][profile].overflow,false,width + "/" + profile + " must not overflow horizontally");
    }
  }

  await page.reload();
  await page.check('.mail-row[data-message-id="m2"] [data-change="select"]');
  await page.click('[data-action="bulk-archive"]');
  await page.click('[data-action="folder-open"][data-id="archive"]');
  await page.fill('.search-input',"資料");
  await page.click('.demo-profile-switcher [data-action="profile"][data-profile="command"]');
  await page.click('.mail-row[data-message-id="m2"] .mail-open');
  await page.click('[data-action="compose-new"]');
  await page.selectOption('[data-compose="from"]',"support@quickmail.invalid");
  await page.fill('[data-compose="to"]',"person@recipient.invalid");
  await page.fill('[data-compose="cc"]',"copy@recipient.invalid");
  await page.fill('[data-compose="bcc"]',"hidden@recipient.invalid");
  await page.fill('[data-compose="subject"]',"切替保持テスト");
  await page.fill('[data-compose="body"]',"本文も保持します");
  await page.click('[data-action="add-attachment"]');
  await page.click('.demo-profile-switcher [data-action="profile"][data-profile="classic"]');
  assert.deepEqual(await page.evaluate(() => ({
    profile:state.profile,
    view:state.view,
    mailboxContext:state.mailboxContext,
    compose:state.compose,
    search:state.search,
    previousView:state.previousView,
    selectedMessageId:state.selectedMessageId,
    listAnchorId:state.listAnchorId,
    focusAnchor:state.focusAnchor
  })),{
    profile:"classic",
    view:"compose",
    mailboxContext:{view:"folder",folderId:"archive"},
    compose:{mode:"new",from:"support@quickmail.invalid",to:"person@recipient.invalid",cc:"copy@recipient.invalid",bcc:"hidden@recipient.invalid",subject:"切替保持テスト",body:"本文も保持します",attachments:[{id:"demo-attachment",name:"参考資料.pdf",size:128000,type:"application/pdf"}],draftId:null},
    search:"資料",
    previousView:"folder",
    selectedMessageId:"m2",
    listAnchorId:"m2",
    focusAnchor:"profile-selector"
  },"real profile switching must preserve mailbox identity, m2, search, and every unsaved draft field");
  assert.equal(await page.locator(".demo-profile-switcher").count(),1,"profile selector must remain visible while composing");
  await page.click('[data-action="compose-close"]');
  assert.deepEqual(await page.evaluate(() => ({view:state.view,folderId:state.activeMailId,selectedMessageId:state.selectedMessageId})),{view:"folder",folderId:"archive",selectedMessageId:"m2"},"closing compose must resume the explicit mailbox state path");

  await page.click('.demo-profile-switcher [data-action="profile"][data-profile="command"]');
  assert.match(await page.textContent(".command-actionbar"),/新規メール.*返信.*転送.*アーカイブ.*移動.*その他/u,"command profile must expose its one-line core command bar");
  await page.click('.demo-profile-switcher [data-action="profile"][data-profile="classic"]');
  assert.match(await page.textContent(".classic-actionbar"),/更新.*新規メール.*返信.*転送.*タグ.*その他/u,"classic profile must expose its top toolbar");
  assert.equal(await page.locator(".classic-quick-filter").count(),1,"classic quick filter must be persistent");
  await page.fill(".classic-quick-filter","2025年度");
  await page.press(".classic-quick-filter","Enter");
  assert.equal(await page.locator('.mail-row[data-message-id="m6"]').count(),1,"classic quick filter must retain a matching thread");
  assert.equal(await page.locator('.mail-row[data-message-id="m2"]').count(),0,"classic quick filter must remove a non-matching thread");

  await page.setViewportSize({width:1024,height:900});
  await page.reload();
  const calmRail = await page.evaluate(() => ({
    folderLabelVisible:getComputedStyle(document.querySelector(".section-label > span")).clipPath === "none",
    verticalText:[...document.querySelectorAll(".sidebar *")].some(element => getComputedStyle(element).writingMode !== "horizontal-tb"),
    named:[...document.querySelectorAll(".sidebar button")].every(button => Boolean(button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent.trim()))
  }));
  assert.deepEqual(calmRail,{folderLabelVisible:false,verticalText:false,named:true},"calm compact rail must use named controls without vertical folder text");

  await page.setViewportSize({width:1440,height:900});
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
  assert.deepEqual(await page.evaluate(() => ({
    sidebar:document.querySelector(".sidebar").inert,
    content:document.querySelector(".content-shell").inert,
    banner:document.querySelector(".demo-banner").inert,
    bannerHidden:document.querySelector(".demo-banner").getAttribute("aria-hidden")
  })),{sidebar:true,content:true,banner:true,bannerHidden:"true"},"all persistent background controls must be inert and hidden from assistive technology while a dialog is open");
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
  for (const profile of ["calm","command","classic"]) {
    await page.evaluate(value => {
      dispatch({type:"NAVIGATE",view:"inbox"});
      dispatch({type:"PROFILE",value});
      dispatch({type:"THEME",value:"dark"});
    },profile);
    assert.equal(await page.getAttribute("html","data-theme"),"dark");
    mobileGeometry[profile] = await page.evaluate(() => {
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
        rowHeight:Math.round(document.querySelector(".mail-row").getBoundingClientRect().height),
        visibleMailPanes:[...document.querySelectorAll('[data-pane="navigation"],[data-pane="message-list"],[data-pane="thread-list"],[data-pane="reading"]')].filter(visible).length,
        columnHeaderVisible:Boolean(document.querySelector('[data-role="thread-columns"]') && visible(document.querySelector('[data-role="thread-columns"]')))
      };
    });
    assert.equal(mobileGeometry[profile].documentWidth,390,profile + " must not overflow the mobile viewport");
    assert.equal(mobileGeometry[profile].bodyWidth,390,profile + " body must not overflow the mobile viewport");
    assert.equal(mobileGeometry[profile].headerOverlap,false,profile + " fixed and flow headers must not overlap");
    assert.deepEqual(mobileGeometry[profile].rowControlOverlaps,[],profile + " row controls must not overlap");
    assert.deepEqual(mobileGeometry[profile].undersized,[],profile + " visible interactive targets must be at least 44px");
    assert.equal(mobileGeometry[profile].visibleMailPanes,1,profile + " must collapse to one mail screen at 390px");
    if (profile === "calm") assert.equal(mobileGeometry[profile].rowHeight,64,"calm mobile rows must be 64px");
    if (profile === "classic") assert.equal(mobileGeometry[profile].rowHeight,52,"classic mobile rows must be 52px");
    assert.equal(mobileGeometry[profile].columnHeaderVisible,false,"classic table header must collapse on mobile");
    await page.click('.mail-row[data-message-id="m2"] .mail-open');
    assert.deepEqual(await page.evaluate(() => ({view:state.view,selectedMessageId:state.selectedMessageId,listAnchorId:state.listAnchorId})),{view:"mail",selectedMessageId:"m2",listAnchorId:"m2"},profile + " must use a single-screen detail at 390px");
    assert.match(await page.textContent("main"),/資料送付のお礼/u);
    assert.equal(await page.locator(".demo-profile-switcher").count(),1,"profile selector must remain visible on mobile detail");
    await page.click('[data-action="back"]');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.focusKey),"message-m2",profile + " mobile back must restore m2 focus");
    await page.evaluate(() => dispatch({type:"THEME",value:"light"}));
  }

  const mobileSettingsGeometry = {};
  for (const profile of ["calm","command","classic"]) {
    mobileSettingsGeometry[profile] = {};
    for (const theme of ["light","dark"]) {
      await page.evaluate(({profile,theme}) => {
        dispatch({type:"PROFILE",value:profile});
        dispatch({type:"THEME",value:theme});
        dispatch({type:"NAVIGATE",view:"settings"});
      },{profile,theme});
      mobileSettingsGeometry[profile][theme] = await page.evaluate(() => {
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
      const geometry = mobileSettingsGeometry[profile][theme];
      assert.ok(geometry.documentWidth <= geometry.viewport,profile + "/" + theme + " settings document must not overflow");
      assert.ok(geometry.bodyWidth <= geometry.viewport,profile + "/" + theme + " settings body must not overflow");
      assert.ok(geometry.cards.every(card => card.left >= 0 && card.right <= geometry.viewport + 0.5 && card.width <= geometry.viewport),profile + "/" + theme + " settings cards must fit the viewport");
      assert.ok(geometry.longContent.every(Boolean),profile + "/" + theme + " prompt and disclosure must wrap within their cards");
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
  assert.ok(passiveRequests.length > 0 && passiveRequests.every(url => url === pathToFileURL(htmlPath).href),"passive operation may request only the same local document");
  console.log(JSON.stringify({
    status:"PASS",
    hash,
    parsed,
    profiles:["calm","command","classic"],
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
