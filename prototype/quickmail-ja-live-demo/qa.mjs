import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium, firefox, webkit } from 'playwright';

const directory = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(directory, 'index.html');
const pageUrl = pathToFileURL(htmlPath).href;
const artifacts = '/tmp/qmj-12c-artifacts';
const profiles = ['calm', 'command', 'classic'];
const themes = ['light', 'dark'];
const axeStates = ['inbox', 'selected', 'compose', 'error'];
const axeWidths = [
	{ name: 'desktop', width: 1440, height: 900 },
	{ name: 'mobile', width: 390, height: 844 }
];
const snapshotWidths = [
	{ name: 'desktop', width: 1440, height: 900 },
	{ name: 'tablet', width: 1024, height: 768 },
	{ name: 'mobile', width: 390, height: 844 }
];
const fixedClock = '2026-08-27T03:04:05.000Z';
const flowLog = [];

fs.rmSync(artifacts, { recursive: true, force: true });
fs.mkdirSync(path.join(artifacts, 'screenshots'), { recursive: true });

function log(event, detail = {}) {
	flowLog.push({ event, ...detail });
}

async function newContext(browser, viewport) {
	const context = await browser.newContext({
		viewport: { width: viewport.width, height: viewport.height },
		locale: 'ja-JP',
		timezoneId: 'Asia/Tokyo',
		deviceScaleFactor: 1,
		colorScheme: 'light',
		reducedMotion: 'reduce'
	});
	await context.addInitScript((value) => {
		Object.defineProperty(window, '__QMJ_FIXTURE_CLOCK', { value, configurable: false });
	}, fixedClock);
	await context.route('http://**/*', (route) => route.abort());
	await context.route('https://**/*', (route) => route.abort());
	return context;
}

async function openDemo(page) {
	await page.goto(pageUrl);
	await page.waitForSelector('.app');
}

async function setScenario(page, { profile, theme, state }) {
	await page.evaluate(
		({ profile, theme, state }) => {
			dispatch({ type: 'RESET' });
			dispatch({ type: 'PROFILE', value: profile });
			dispatch({ type: 'THEME', value: theme });
			dispatch({ type: 'NAVIGATE', view: 'inbox' });
			if (state === 'selected') dispatch({ type: 'OPEN_MAIL', id: 'm2' });
			if (state === 'compose' || state === 'error') dispatch({ type: 'OPEN_COMPOSE', mode: 'new' });
			if (state === 'error') dispatch({ type: 'REQUEST_SEND' });
		},
		{ profile, theme, state }
	);
	await page.locator('.app').waitFor();
}

async function scanMobileTargets(page, label) {
	const result = await page.evaluate(() => {
		const visible = (element) => {
			const style = getComputedStyle(element);
			const box = element.getBoundingClientRect();
			return (
				style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
			);
		};
		const interactive = [
			...document.querySelectorAll('button,input:not([type="hidden"]),select,textarea,a[href]')
		].filter(visible);
		const undersized = interactive.flatMap((element) => {
			const target = element.matches('input[type="checkbox"]')
				? element.closest('.select-wrap,.select-hit,.acknowledge') || element
				: element;
			const box = target.getBoundingClientRect();
			if (box.width >= 43.5 && box.height >= 43.5) return [];
			return [
				{
					tag: element.tagName,
					action: element.dataset.action || '',
					name: element.getAttribute('aria-label') || element.textContent.trim().slice(0, 40),
					width: Math.round(box.width * 10) / 10,
					height: Math.round(box.height * 10) / 10
				}
			];
		});
		const from = document.querySelector('[data-compose="from"]')?.getBoundingClientRect();
		return {
			viewport: innerWidth,
			documentWidth: document.documentElement.scrollWidth,
			bodyWidth: document.body.scrollWidth,
			undersized,
			fromHeight: from ? Math.round(from.height * 10) / 10 : null
		};
	});
	assert.ok(result.documentWidth <= result.viewport + 0.5, `${label} document must not overflow`);
	assert.ok(result.bodyWidth <= result.viewport + 0.5, `${label} body must not overflow`);
	assert.deepEqual(
		result.undersized,
		[],
		`${label} visible interactive targets must be at least 44px`
	);
	if (result.fromHeight != null)
		assert.ok(result.fromHeight >= 43.5, `${label} compose From select must be at least 44px`);
	return result;
}

async function axeScan(page, label) {
	const result = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
		.analyze();
	const blocking = result.violations.filter((violation) =>
		['moderate', 'serious', 'critical'].includes(violation.impact)
	);
	assert.deepEqual(
		blocking.map((violation) => ({
			id: violation.id,
			impact: violation.impact,
			nodes: violation.nodes.map((node) => node.target)
		})),
		[],
		`${label} must have zero moderate/serious/critical WCAG A/AA axe violations`
	);
	return {
		label,
		passes: result.passes.length,
		incomplete: result.incomplete.length,
		violations: result.violations.length
	};
}

function channel(value) {
	const normalized = value / 255;
	return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function rgb(value) {
	if (String(value).startsWith('#')) {
		let hex = String(value).slice(1);
		if (hex.length === 3) hex = [...hex].map((character) => character + character).join('');
		assert.match(hex, /^[0-9a-f]{6}$/iu, `unsupported color: ${value}`);
		return hex.match(/../gu).map((pair) => Number.parseInt(pair, 16));
	}
	const match = String(value).match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/u);
	assert.ok(match, `unsupported color: ${value}`);
	return match.slice(1, 4).map(Number);
}

function ratio(foreground, background) {
	const [fr, fg, fb] = rgb(foreground);
	const [br, bg, bb] = rgb(background);
	const first = 0.2126 * channel(fr) + 0.7152 * channel(fg) + 0.0722 * channel(fb);
	const second = 0.2126 * channel(br) + 0.7152 * channel(bg) + 0.0722 * channel(bb);
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

async function contrastRecord(page, profile, theme) {
	await setScenario(page, { profile, theme, state: 'inbox' });
	await page.hover('.mail-row[data-message-id="m2"]');
	const values = await page.evaluate(() => {
		const style = (selector) => getComputedStyle(document.querySelector(selector));
		const root = style('.app');
		const base = style('.mail-row[data-message-id="m2"] .mail-open');
		const hover = style('.mail-row[data-message-id="m2"]');
		const unreadText = style('.mail-row[data-message-id="m1"] .mail-open');
		const unread = style('.mail-row[data-message-id="m1"]');
		return {
			surface: root.getPropertyValue('--surface').trim(),
			accent: root.getPropertyValue('--accent').trim(),
			focus: root.getPropertyValue('--accent').trim(),
			defaultText: base.color,
			defaultBackground: root.getPropertyValue('--surface').trim(),
			hoverText: base.color,
			hoverBackground: hover.backgroundColor,
			unreadText: unreadText.color,
			unreadBackground: unread.backgroundColor
		};
	});
	await page.focus('.search-input');
	const focusBorder = await page.$eval(
		'.search-input',
		(element) => getComputedStyle(element).borderColor
	);
	await page.evaluate(() => {
		dispatch({ type: 'VERIFY_FORWARD' });
		dispatch({ type: 'NAVIGATE', view: 'settings' });
	});
	const disabled = await page.$eval('button[data-action="forward-enable"]:disabled', (element) => {
		const style = getComputedStyle(element);
		return { opacity: style.opacity, text: style.color, background: style.backgroundColor };
	});
	const samples = {
		default: ratio(values.defaultText, values.defaultBackground),
		hover: ratio(values.hoverText, values.hoverBackground),
		unread: ratio(values.unreadText, values.unreadBackground),
		selectedBoundary: ratio(values.accent, values.surface),
		focusIndicator: ratio(focusBorder, values.surface),
		disabled: { ...disabled, wcagContrastExempt: true }
	};
	for (const key of ['default', 'hover', 'unread'])
		assert.ok(
			samples[key] >= 4.5,
			`${profile}/${theme}/${key} normal text contrast must be >= 4.5:1`
		);
	for (const key of ['selectedBoundary', 'focusIndicator'])
		assert.ok(samples[key] >= 3, `${profile}/${theme}/${key} contrast must be >= 3:1`);
	return { profile, theme, samples };
}

async function tabUntil(page, selector, label, max = 120) {
	for (let index = 0; index < max; index += 1) {
		if (
			await page
				.locator(selector)
				.evaluateAll(
					(elements, active) => elements.includes(active),
					await page.evaluateHandle(() => document.activeElement)
				)
		) {
			log('keyboard-target', { label, tabs: index });
			return;
		}
		await page.keyboard.press('Tab');
	}
	assert.fail(`${label} must be keyboard reachable within ${max} Tab presses`);
}

async function keyboardFlow(page, profile) {
	await setScenario(page, { profile, theme: 'light', state: 'inbox' });
	await page.evaluate(() => document.body.focus());
	await tabUntil(page, '.search-input', `${profile}:search`);
	await page.keyboard.type('資料');

	await page.evaluate(() => document.body.focus());
	await tabUntil(page, '.compose-new', `${profile}:compose`);
	await page.keyboard.press('Enter');
	assert.equal(await page.evaluate(() => state.view), 'compose');
	await page.evaluate(() => document.body.focus());
	await tabUntil(page, '[data-action="compose-close"]', `${profile}:compose-close`);
	await page.keyboard.press('Enter');

	await page.evaluate(() => document.body.focus());
	await tabUntil(page, '[data-action="navigate"][data-view="inbox"]', `${profile}:navigation`);
	await page.keyboard.press('Enter');
	await page.evaluate(() => document.body.focus());
	await tabUntil(page, '.mail-row[data-message-id="m2"] .mail-open', `${profile}:message`);
	await page.keyboard.press('Enter');
	if (await page.locator('[data-pane="reading"]').count()) {
		await page.evaluate(() => document.body.focus());
		await tabUntil(
			page,
			'[data-pane="reading"] [data-action="open-mail-detail"]',
			`${profile}:open-detail`
		);
		await page.keyboard.press('Enter');
	}
	await page.evaluate(() => document.body.focus());
	await tabUntil(page, '[data-focus-key="message-body"]', `${profile}:message-body`);
	await page.keyboard.press('Tab');
	assert.equal(
		await page.evaluate(() => document.activeElement?.dataset.action),
		'reply',
		`${profile} reply must follow the body in keyboard order`
	);
	log('keyboard-flow-complete', { profile });
}

async function restorationAndAnchor(page, profile) {
	await page.setViewportSize({ width: 390, height: 844 });
	await setScenario(page, { profile, theme: 'light', state: 'inbox' });
	await page.addStyleTag({
		content: '.mail-row[data-message-id="m2"]{margin-top:1100px!important}'
	});
	await page.locator('.mail-row[data-message-id="m2"] .mail-open').focus();
	await page.keyboard.press('Enter');
	await page.evaluate(() => document.body.focus());
	await tabUntil(page, '[data-action="back"]', `${profile}:back`);
	await page.keyboard.press('Enter');
	const anchor = await page.locator('.mail-row[data-message-id="m2"] .mail-open').boundingBox();
	assert.ok(
		anchor && anchor.y >= 0 && anchor.y + anchor.height <= 844,
		`${profile} restored long/offscreen logical anchor must be visible: ${JSON.stringify(anchor)}`
	);

	await page.setViewportSize({ width: 1440, height: 900 });
	await setScenario(page, { profile, theme: 'light', state: 'inbox' });
	const trigger = page.locator('[data-action="folder-modal"]');
	await trigger.focus();
	await page.keyboard.press('Enter');
	await page.keyboard.press('Escape');
	assert.equal(
		await page.evaluate(() => document.activeElement?.dataset.action),
		'folder-modal',
		`${profile} dialog must restore trigger focus`
	);
	await page.locator(`.demo-profile-switcher [data-profile="${profile}"]`).focus();
	await page.keyboard.press('Enter');
	assert.equal(
		await page.evaluate(() => document.activeElement?.dataset.focusKey),
		'message-m1',
		`${profile} profile switch must restore the logical message focus`
	);
}

async function reducedMotionCheck(page, profile) {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await setScenario(page, { profile, theme: 'light', state: 'inbox' });
	const moving = await page.evaluate(() =>
		[...document.querySelectorAll('.app *')].flatMap((element) => {
			const style = getComputedStyle(element);
			const duration = `${style.animationDuration},${style.transitionDuration}`
				.split(',')
				.some((value) => parseFloat(value) > 0);
			return duration ? [element.outerHTML.slice(0, 100)] : [];
		})
	);
	assert.deepEqual(
		moving,
		[],
		`${profile} must disable decorative motion when reduced motion is requested`
	);
}

async function runChromium() {
	const browser = await chromium.launch({ headless: true });
	const context = await newContext(browser, snapshotWidths[0]);
	const tracePath = path.join(artifacts, 'trace.zip');
	await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
	const page = await context.newPage();
	const pageErrors = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	await openDemo(page);

	const axeResults = [];
	const mobileResults = [];
	for (const profile of profiles) {
		for (const theme of themes) {
			for (const state of axeStates) {
				for (const viewport of axeWidths) {
					await page.setViewportSize({ width: viewport.width, height: viewport.height });
					await setScenario(page, { profile, theme, state });
					const label = `${profile}/${theme}/${state}/${viewport.name}`;
					axeResults.push(await axeScan(page, label));
					const overflow = await page.evaluate(() => ({
						viewport: innerWidth,
						document: document.documentElement.scrollWidth,
						body: document.body.scrollWidth
					}));
					assert.ok(
						overflow.document <= overflow.viewport + 0.5 &&
							overflow.body <= overflow.viewport + 0.5,
						`${label} must not overflow horizontally`
					);
					if (viewport.name === 'mobile')
						mobileResults.push({ label, ...(await scanMobileTargets(page, label)) });
				}
			}
		}
	}
	assert.equal(axeResults.length, 48, 'the full axe matrix must contain exactly 48 runs');

	const screenshots = [];
	for (const profile of profiles) {
		for (const theme of themes) {
			for (const viewport of snapshotWidths) {
				await page.setViewportSize({ width: viewport.width, height: viewport.height });
				await setScenario(page, { profile, theme, state: 'inbox' });
				const file = path.join(
					artifacts,
					'screenshots',
					`${profile}-${theme}-${viewport.name}.png`
				);
				await page.screenshot({
					path: file,
					fullPage: false,
					animations: 'disabled',
					caret: 'hide'
				});
				screenshots.push({
					profile,
					theme,
					viewport: `${viewport.width}x${viewport.height}`,
					file,
					sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
				});
			}
		}
	}
	assert.equal(
		screenshots.length,
		18,
		'the deterministic default-state screenshot matrix must contain exactly 18 files'
	);

	const contrasts = [];
	await page.setViewportSize({ width: 1440, height: 900 });
	for (const profile of profiles)
		for (const theme of themes) contrasts.push(await contrastRecord(page, profile, theme));
	for (const profile of profiles) {
		await keyboardFlow(page, profile);
		await restorationAndAnchor(page, profile);
		await reducedMotionCheck(page, profile);
	}
	assert.deepEqual(pageErrors, [], 'Chromium must report zero page errors');
	await context.tracing.stop({ path: tracePath });
	await context.close();
	await browser.close();
	return { axeResults, mobileResults, screenshots, contrasts, tracePath };
}

async function runBrowserSmoke(name, browserType) {
	const browser = await browserType.launch({ headless: true });
	const context = await newContext(browser, axeWidths[1]);
	const page = await context.newPage();
	await openDemo(page);
	const results = [];
	for (const profile of profiles) {
		await setScenario(page, { profile, theme: 'dark', state: 'inbox' });
		results.push(await axeScan(page, `${name}/${profile}/dark/inbox/mobile`));
		await scanMobileTargets(page, `${name}/${profile}/dark/inbox/mobile`);
		await page.locator('.mail-row[data-message-id="m2"] .mail-open').focus();
		await page.keyboard.press('Enter');
		assert.equal(
			await page.evaluate(() => state.selectedMessageId),
			'm2',
			`${name}/${profile} must select a message`
		);
		await page.evaluate(() => dispatch({ type: 'OPEN_COMPOSE', mode: 'new' }));
		assert.equal(
			await page.locator('[data-compose="from"]').count(),
			1,
			`${name}/${profile} must open compose`
		);
	}
	await context.close();
	await browser.close();
	return results;
}

const chromiumResults = await runChromium();
const browserSmoke = {
	firefox: await runBrowserSmoke('firefox', firefox),
	webkit: await runBrowserSmoke('webkit', webkit)
};

fs.writeFileSync(path.join(artifacts, 'ui-flow-log.json'), JSON.stringify(flowLog, null, 2) + '\n');
const manifest = {
	status: 'PASS_AUTOMATED',
	generatedAtFixtureClock: fixedClock,
	environment: { locale: 'ja-JP', timezone: 'Asia/Tokyo', deviceScaleFactor: 1 },
	axeRuns: chromiumResults.axeResults.length,
	screenshots: chromiumResults.screenshots,
	contrasts: chromiumResults.contrasts,
	browserSmoke: Object.fromEntries(
		Object.entries(browserSmoke).map(([name, values]) => [name, values.length])
	),
	artifacts: {
		trace: chromiumResults.tracePath,
		screenshots: path.join(artifacts, 'screenshots'),
		uiFlowLog: path.join(artifacts, 'ui-flow-log.json')
	},
	voiceOver: {
		status: 'UNVERIFIED_HUMAN_GATE',
		checklist: path.join(directory, 'VOICEOVER-CHECKLIST.md')
	}
};
fs.writeFileSync(path.join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
