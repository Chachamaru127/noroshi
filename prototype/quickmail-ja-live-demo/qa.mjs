import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import pixelmatch from 'pixelmatch';
import { chromium, firefox, webkit } from 'playwright';
import { PNG } from 'pngjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(directory, 'index.html');
const pageUrl = pathToFileURL(htmlPath).href;
const axeIncompleteReview = JSON.parse(
	fs.readFileSync(path.join(directory, 'axe-incomplete-review.json'), 'utf8')
);
const artifactOverride = process.env.QMJ12C_ARTIFACT_DIR;
const tempRoot = fs.realpathSync(os.tmpdir());
function createArtifactDirectory(override) {
	const fallback = (error = null) => ({
		directory: fs.mkdtempSync(path.join(tempRoot, 'qmj-12c-artifacts-')),
		preflightError: error
	});
	if (!override) return fallback();
	try {
		const root = path.resolve(override);
		if (fs.existsSync(root)) {
			const stat = fs.lstatSync(root);
			assert.ok(
				stat.isDirectory() && !stat.isSymbolicLink(),
				'artifact root must be a real directory'
			);
		} else {
			const parent = path.dirname(root);
			const parentStat = fs.statSync(parent);
			assert.ok(parentStat.isDirectory(), 'artifact root parent must be a directory');
			const realParent = fs.realpathSync(parent);
			const prospectiveRoot = path.join(realParent, path.basename(root));
			assert.ok(
				prospectiveRoot.startsWith(`${tempRoot}${path.sep}`),
				'QMJ12C_ARTIFACT_DIR must be a child of the real OS temporary directory'
			);
			fs.mkdirSync(root);
		}
		const realRoot = fs.realpathSync(root);
		assert.ok(
			realRoot.startsWith(`${tempRoot}${path.sep}`),
			'QMJ12C_ARTIFACT_DIR must be a child of the real OS temporary directory'
		);
		return { directory: fs.mkdtempSync(path.join(realRoot, 'run-')), preflightError: null };
	} catch (error) {
		return fallback(error);
	}
}
const artifactSetup = createArtifactDirectory(artifactOverride);
const artifacts = artifactSetup.directory;
const baselineDirectory = path.join(directory, 'baselines', 'playwright-1.59.1-noble');
const updateBaselines = process.argv.includes('--update-baselines');
const baselineVersion = 'playwright-1.59.1-noble-linux-amd64';
const pinnedContainerTag = 'mcr.microsoft.com/playwright:v1.59.1-noble';
const pinnedImageDigest = 'sha256:eac9b0a5312cdab40ee8c2429df5bf19bffdccf8f3bf3c42268e173f97541645';
const pinnedContainer = `mcr.microsoft.com/playwright@${pinnedImageDigest}`;
const baselineMode =
	process.env.QMJ12C_BASELINE_MODE || (process.platform === 'linux' ? 'exact' : 'threshold');
const allowedMismatchRatio = Number(process.env.QMJ12C_PIXEL_THRESHOLD || '0.025');
const expectedReferenceEnvironment = {
	osPrettyName: 'Ubuntu 24.04.4 LTS',
	node: 'v24.14.1',
	playwright: '1.59.1',
	chromium: '147.0.7727.15',
	firefox: '148.0.2',
	webkit: '26.4'
};
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
const evidence = {
	axeCells: [],
	mobileCells: [],
	scenarioStructures: [],
	screenshots: [],
	contrasts: [],
	browserCells: {},
	browserVersions: {},
	errors: [],
	failedCell: null,
	failureScreenshot: null
};
let currentCell = 'preflight';

function gitCommit() {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: path.resolve(directory, '../..'),
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
	} catch {
		return process.env.QMJ12C_COMMIT || process.env.GITHUB_SHA || 'unknown';
	}
}

function dependencyVersion(name) {
	return JSON.parse(
		fs.readFileSync(path.resolve(directory, '../..', 'node_modules', name, 'package.json'), 'utf8')
	).version;
}

fs.mkdirSync(path.join(artifacts, 'screenshots'), { recursive: true });
let baselineStagingDirectory = null;

function prepareBaselineStaging() {
	if (!updateBaselines) return;
	assert.equal(baselineStagingDirectory, null);
	baselineStagingDirectory = fs.mkdtempSync(
		path.join(path.dirname(baselineDirectory), '.baseline-staging-')
	);
}

function cleanupBaselineStaging() {
	if (baselineStagingDirectory && fs.existsSync(baselineStagingDirectory))
		fs.rmSync(baselineStagingDirectory, { recursive: true });
	baselineStagingDirectory = null;
}

function preflight() {
	if (artifactSetup.preflightError) throw artifactSetup.preflightError;
	assert.ok(
		['exact', 'threshold'].includes(baselineMode),
		'baseline mode must be exact or threshold'
	);
	assert.ok(
		Number.isFinite(allowedMismatchRatio) &&
			allowedMismatchRatio >= 0 &&
			allowedMismatchRatio <= 0.025,
		'pixel threshold must be finite and between 0 and 0.025'
	);
	assert.ok(!updateBaselines || baselineMode === 'exact', 'baseline update requires exact mode');
	const expiry = Date.parse(`${axeIncompleteReview.expiresAt}T23:59:59Z`);
	assert.ok(
		Number.isFinite(expiry) && Date.now() <= expiry,
		'axe incomplete review record has expired'
	);
}

function referenceEnvironmentGuard(chromiumVersion) {
	if (!updateBaselines) return;
	const release = fs.readFileSync('/etc/os-release', 'utf8');
	assert.ok(fs.existsSync('/.dockerenv'), 'baseline update requires a container environment');
	assert.equal(process.platform, 'linux');
	assert.equal(process.arch, 'x64');
	assert.match(release, /^PRETTY_NAME="Ubuntu 24\.04\.4 LTS"$/mu);
	assert.equal(process.version, expectedReferenceEnvironment.node);
	assert.equal(dependencyVersion('playwright'), expectedReferenceEnvironment.playwright);
	assert.equal(chromiumVersion, expectedReferenceEnvironment.chromium);
	assert.equal(process.env.QMJ12C_REFERENCE_CONTAINER, pinnedContainer);
	assert.equal(process.env.QMJ12C_REFERENCE_MARKER, baselineVersion);
}

function compareBaseline(actualFile, filename) {
	const baselineFile = path.join(baselineDirectory, filename);
	const comparisonFile = updateBaselines
		? path.join(assertBaselineStaging(), filename)
		: baselineFile;
	if (updateBaselines) {
		fs.copyFileSync(actualFile, comparisonFile, fs.constants.COPYFILE_EXCL);
	}
	assert.ok(
		fs.existsSync(comparisonFile),
		`${filename} reviewed baseline is missing; use --update-baselines only in the pinned Playwright container`
	);
	const actual = PNG.sync.read(fs.readFileSync(actualFile));
	const expected = PNG.sync.read(fs.readFileSync(comparisonFile));
	assert.deepEqual(
		{ width: actual.width, height: actual.height },
		{ width: expected.width, height: expected.height },
		`${filename} dimensions must match its reviewed baseline`
	);
	const diff = new PNG({ width: actual.width, height: actual.height });
	const mismatchPixels = pixelmatch(
		expected.data,
		actual.data,
		diff.data,
		actual.width,
		actual.height,
		{
			threshold: 0.1,
			includeAA: false
		}
	);
	const mismatchRatio = mismatchPixels / (actual.width * actual.height);
	if (mismatchPixels > 0) {
		fs.mkdirSync(path.join(artifacts, 'diffs'), { recursive: true });
		fs.writeFileSync(path.join(artifacts, 'diffs', filename), PNG.sync.write(diff));
	}
	const allowed = baselineMode === 'exact' ? 0 : allowedMismatchRatio;
	assert.ok(
		mismatchRatio <= allowed,
		`${filename} differs from baseline by ${(mismatchRatio * 100).toFixed(3)}% (allowed ${(allowed * 100).toFixed(3)}%)`
	);
	return {
		baselineFile,
		baselineSha256: crypto
			.createHash('sha256')
			.update(fs.readFileSync(comparisonFile))
			.digest('hex'),
		mismatchPixels,
		mismatchRatio,
		allowedMismatchRatio: allowed,
		mode: baselineMode,
		updated: updateBaselines
	};
}

function assertBaselineStaging() {
	assert.ok(
		baselineStagingDirectory,
		'baseline staging must be prepared after environment preflight'
	);
	return baselineStagingDirectory;
}

function finalizeBaselineUpdate() {
	if (!updateBaselines) return null;
	const expected = profiles
		.flatMap((profile) =>
			themes.flatMap((theme) =>
				snapshotWidths.map((viewport) => `${profile}-${theme}-${viewport.name}.png`)
			)
		)
		.sort();
	const staging = assertBaselineStaging();
	const actual = fs.readdirSync(staging).sort();
	assert.deepEqual(actual, expected, 'baseline staging must contain the exact 18-file matrix');
	for (const filename of actual) PNG.sync.read(fs.readFileSync(path.join(staging, filename)));
	const backup = `${baselineDirectory}.backup-${crypto.randomUUID()}`;
	let movedExisting = false;
	try {
		if (fs.existsSync(baselineDirectory)) {
			fs.renameSync(baselineDirectory, backup);
			movedExisting = true;
		}
		fs.renameSync(staging, baselineDirectory);
		baselineStagingDirectory = null;
		if (movedExisting) fs.rmSync(backup, { recursive: true });
	} catch (error) {
		if (!fs.existsSync(baselineDirectory) && movedExisting && fs.existsSync(backup)) {
			fs.renameSync(backup, baselineDirectory);
		}
		throw error;
	}
	return { version: baselineVersion, files: expected };
}

function writeVisualReviewCandidate(sourceDirectory = baselineDirectory) {
	const screenshots = fs
		.readdirSync(sourceDirectory)
		.filter((filename) => filename.endsWith('.png'))
		.sort()
		.map((filename) => ({
			file: filename,
			sha256: crypto
				.createHash('sha256')
				.update(fs.readFileSync(path.join(sourceDirectory, filename)))
				.digest('hex')
		}));
	assert.equal(screenshots.length, 18);
	const candidate = {
		reviewedCommit: gitCommit(),
		baselineVersion,
		containerTag: pinnedContainerTag,
		containerImage: pinnedContainer,
		imageDigest: pinnedImageDigest,
		generatedAt: new Date().toISOString(),
		decision: 'PENDING_HUMAN_REVIEW',
		screenshots
	};
	const candidatePath = path.join(artifacts, 'baseline-review-candidate.json');
	fs.writeFileSync(candidatePath, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
	return candidatePath;
}

function writeVoiceOverReviewCandidate() {
	const candidate = {
		reviewedCommit: gitCommit(),
		contentSha256: crypto.createHash('sha256').update(fs.readFileSync(htmlPath)).digest('hex'),
		checklistSha256: crypto
			.createHash('sha256')
			.update(fs.readFileSync(path.join(directory, 'VOICEOVER-CHECKLIST.md')))
			.digest('hex'),
		generatedAt: new Date().toISOString(),
		decision: 'PENDING_HUMAN_REVIEW',
		environment: { macosVersion: '', safariVersion: '', voiceOverVersion: '' },
		profiles: profiles.map((profile) => ({
			profile,
			status: 'PENDING',
			heardText: '',
			notes: ''
		}))
	};
	const candidatePath = path.join(artifacts, 'voiceover-review-candidate.json');
	fs.writeFileSync(candidatePath, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
	return candidatePath;
}

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
			if (state === 'selected') {
				const inline =
					matchMedia('(min-width: 768px)').matches && ['command', 'classic'].includes(profile);
				dispatch({ type: inline ? 'SELECT_MAIL' : 'OPEN_MAIL', id: 'm2' });
			}
			if (state === 'compose' || state === 'error') dispatch({ type: 'OPEN_COMPOSE', mode: 'new' });
			if (state === 'error') dispatch({ type: 'REQUEST_SEND' });
		},
		{ profile, theme, state }
	);
	await page.locator('.app').waitFor();
}

async function assertAccessibleState(page) {
	await page.setViewportSize({ width: 1440, height: 900 });
	await setScenario(page, { profile: 'command', theme: 'light', state: 'inbox' });
	const initial = await page.evaluate(() => ({
		currentNav: document.querySelector('.nav-btn.active')?.getAttribute('aria-current'),
		currentMessage: document
			.querySelector('.mail-row[data-message-id="m1"] .mail-open')
			?.getAttribute('aria-current'),
		currentName: document
			.querySelector('.mail-row[data-message-id="m1"] .mail-open')
			?.getAttribute('aria-label'),
		unreadName: document
			.querySelector('.mail-row[data-message-id="m2"] .mail-open')
			?.getAttribute('aria-label')
	}));
	assert.equal(
		initial.currentNav,
		'page',
		'active mailbox navigation must expose aria-current=page'
	);
	assert.equal(
		initial.currentMessage,
		'true',
		'the current message control must expose aria-current'
	);
	assert.match(
		initial.currentName || '',
		/未読.*選択中/u,
		'current unread message name must expose both states'
	);
	assert.match(initial.unreadName || '', /未読/u, 'unread message name must expose unread state');
	await page.evaluate(() => dispatch({ type: 'SELECT_MAIL', id: 'm2' }));
	const selected = await page
		.locator('.mail-row[data-message-id="m2"] .mail-open')
		.evaluate((element) => ({
			current: element.getAttribute('aria-current'),
			name: element.getAttribute('aria-label')
		}));
	assert.equal(selected.current, 'true', 'newly selected message must expose aria-current');
	assert.match(
		selected.name || '',
		/選択中/u,
		'newly selected message name must expose selected state'
	);
	assert.doesNotMatch(
		selected.name || '',
		/未読/u,
		'opening a message must remove unread from its name'
	);
}

async function assertOfflineState(page) {
	await setScenario(page, { profile: 'calm', theme: 'light', state: 'inbox' });
	const toggle = page.locator('[data-action="offline-toggle"]');
	await toggle.focus();
	await page.keyboard.press('Enter');
	assert.equal(
		await page.evaluate(() => state.offline),
		true,
		'demo state must explicitly record offline mode'
	);
	assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
	const status = page.locator('[data-status="connectivity"][role="status"][aria-live="polite"]');
	assert.equal(await status.count(), 1, 'offline mode must render one polite live status');
	assert.match(await status.textContent(), /オフライン.*送受信できません/u);
	await page.keyboard.press('Enter');
	assert.equal(await page.evaluate(() => state.offline), false);
	assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
	assert.match(await status.textContent(), /オンライン.*続けられます/u);
}

async function assertScenarioStructure(page, { profile, state, viewport, label }) {
	if (state !== 'selected') return null;
	const actual = await page.evaluate(() => ({
		view: state.view,
		selectedMessageId: state.selectedMessageId,
		messageLists: document.querySelectorAll('[data-pane="message-list"],[data-pane="thread-list"]')
			.length,
		readingPanes: document.querySelectorAll('[data-pane="reading"]').length,
		fullMessage: document.querySelectorAll('.message-body').length
	}));
	const inline = viewport.name === 'desktop' && ['command', 'classic'].includes(profile);
	assert.deepEqual(
		actual,
		inline
			? { view: 'inbox', selectedMessageId: 'm2', messageLists: 1, readingPanes: 1, fullMessage: 0 }
			: { view: 'mail', selectedMessageId: 'm2', messageLists: 0, readingPanes: 0, fullMessage: 1 },
		`${label} selected scenario must exercise its real responsive profile structure`
	);
	return actual;
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
	const incompleteDetails = result.incomplete.map((item) => ({
		id: item.id,
		impact: item.impact,
		help: item.help,
		nodes: item.nodes.map((node) => ({
			target: node.target,
			html: node.html,
			failureSummary: node.failureSummary
		}))
	}));
	const seriousIncomplete = incompleteDetails.filter((item) =>
		['serious', 'critical'].includes(item.impact)
	);
	const incompleteMeasurements = [];
	for (const item of seriousIncomplete) {
		assert.equal(item.id, axeIncompleteReview.ruleId, `${label} unexpected incomplete rule`);
		assert.equal(item.impact, axeIncompleteReview.impact, `${label} unexpected incomplete impact`);
		for (const node of item.nodes) {
			assert.equal(node.target.length, 1, `${label} incomplete node must have one exact selector`);
			const selector = node.target[0];
			const measured = await page.locator(selector).evaluateAll((elements) => {
				if (elements.length !== 1) return { matches: elements.length };
				const element = elements[0];
				const parseColor = (value) => {
					const values = value.match(/[\d.]+/gu)?.map(Number) || [];
					return [values[0], values[1], values[2], values[3] ?? 1];
				};
				const composite = (top, bottom) => {
					const alpha = top[3] + bottom[3] * (1 - top[3]);
					return [
						(top[0] * top[3] + bottom[0] * bottom[3] * (1 - top[3])) / alpha,
						(top[1] * top[3] + bottom[1] * bottom[3] * (1 - top[3])) / alpha,
						(top[2] * top[3] + bottom[2] * bottom[3] * (1 - top[3])) / alpha,
						alpha
					];
				};
				const format = (color) => `rgb(${color.slice(0, 3).join(', ')})`;
				const layers = [];
				let current = element;
				while (current) {
					layers.push(parseColor(getComputedStyle(current).backgroundColor));
					current = current.parentElement;
				}
				let background = [255, 255, 255, 1];
				for (const layer of layers.reverse()) background = composite(layer, background);
				const rawForeground = getComputedStyle(element).color;
				const foreground = composite(parseColor(rawForeground), background);
				return {
					matches: 1,
					foreground: format(foreground),
					background: format(background),
					rawForeground,
					opacity: getComputedStyle(element).opacity
				};
			});
			assert.equal(measured.matches, 1, `${label} ${selector} must identify exactly one node`);
			assert.equal(measured.opacity, '1', `${label} ${selector} element opacity must be 1`);
			const measuredRatio = ratio(measured.foreground, measured.background);
			assert.ok(
				measuredRatio >= axeIncompleteReview.evidence.minimumRatio,
				`${label} ${selector} actual incomplete node contrast ${measuredRatio.toFixed(2)} must be >= ${axeIncompleteReview.evidence.minimumRatio}`
			);
			incompleteMeasurements.push({
				ruleId: item.id,
				impact: item.impact,
				target: node.target,
				html: node.html,
				failureSummary: node.failureSummary,
				foreground: measured.foreground,
				background: measured.background,
				rawForeground: measured.rawForeground,
				ratio: measuredRatio,
				fingerprint: crypto
					.createHash('sha256')
					.update(JSON.stringify([label, item.id, item.impact, node.target, node.html]))
					.digest('hex')
			});
		}
	}
	assert.equal(
		incompleteMeasurements.length,
		seriousIncomplete.reduce((sum, item) => sum + item.nodes.length, 0),
		`${label} every serious/critical incomplete node must have actual-cell evidence`
	);
	return {
		label,
		passes: result.passes.length,
		incompleteCount: result.incomplete.length,
		incomplete: incompleteDetails,
		incompleteMeasurements,
		reviewedIncompleteNodes: seriousIncomplete.reduce((sum, item) => sum + item.nodes.length, 0),
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
	const srgb = String(value).match(
		/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*[\d.]+)?\)/u
	);
	if (srgb) return srgb.slice(1, 4).map((channelValue) => Number(channelValue) * 255);
	const match = String(value).match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/u);
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
	const sample = async (selector) =>
		page.$eval(
			selector,
			(element, selectorLabel) => {
				const opaqueBackground = (start) => {
					let current = start;
					while (current) {
						const color = getComputedStyle(current).backgroundColor;
						if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
						current = current.parentElement;
					}
					return 'rgb(255, 255, 255)';
				};
				const style = getComputedStyle(element);
				return {
					selector: selectorLabel,
					text: style.color,
					background: opaqueBackground(element),
					border: style.borderColor,
					boxShadow: style.boxShadow,
					fontSize: style.fontSize,
					fontWeight: style.fontWeight
				};
			},
			selector
		);
	const normal = await sample('.mail-row[data-message-id="m3"] .mail-open');
	const unread = await sample('.mail-row[data-message-id="m2"] .mail-open');
	const iconSamples = {
		compose: await sample('.compose-new > span[aria-hidden="true"]'),
		activeNavigation: await sample('.nav-btn.active .nav-icon'),
		inactiveNavigation: await sample('.nav-btn:not(.active) .nav-icon'),
		activeStar: await sample('.mail-row.current .star.on'),
		inactiveStar: await sample('.mail-row[data-message-id="m2"] .star:not(.on)'),
		rowAvatar: await sample('.mail-row[data-message-id="m1"] .row-avatar > span'),
		theme: await sample('[data-action="theme-cycle"]')
	};
	if (profile === 'classic') {
		iconSamples.classicStarHeader = await sample('.classic-columns > span:nth-child(2)');
	}
	const searchSurface = await sample('.search-input');
	for (const [name, selector] of [
		['searchSymbol', '.search-symbol'],
		['searchButton', '.search-go']
	]) {
		const value = await sample(selector);
		iconSamples[name] = { ...value, background: searchSurface.background };
	}
	await page.setViewportSize({ width: 390, height: 844 });
	const mobileNavigation = await sample('.mobile-nav button.active .mobile-icon');
	iconSamples.mobileNavigation = mobileNavigation;
	await page.setViewportSize({ width: 1440, height: 900 });
	for (const value of Object.values(iconSamples)) value.ratio = ratio(value.text, value.background);
	await page.hover('.mail-row[data-message-id="m3"]');
	const hover = await sample('.mail-row[data-message-id="m3"] .mail-open');
	await page.focus('.search-input');
	const focus = await sample('.search-input');
	await page.click('[data-action="filter"][data-filter="unread"]');
	const component = await sample('.filter-pill.active');

	await setScenario(page, { profile, theme, state: 'selected' });
	if (!(await page.locator('.mail-detail-head h1').count())) {
		await page.evaluate(() => dispatch({ type: 'OPEN_MAIL', id: 'm2' }));
	}
	iconSamples.back = await sample('[data-action="back"]');
	iconSamples.back.ratio = ratio(iconSamples.back.text, iconSamples.back.background);
	iconSamples.selectedAvatar = await sample('.message-meta .row-avatar');
	iconSamples.selectedAvatar.ratio = ratio(
		iconSamples.selectedAvatar.text,
		iconSamples.selectedAvatar.background
	);
	const large = await sample('.mail-detail-head h1');
	await page.evaluate(() => dispatch({ type: 'RETURN_TO_MAILBOX' }));
	const selected = await page.$eval('.mail-row[data-message-id="m2"]', (element) => {
		const style = getComputedStyle(element);
		const control = getComputedStyle(element.querySelector('.mail-open'));
		const indicator = style.boxShadow.match(/rgba?\([^)]*\)/u)?.[0] || '';
		return {
			text: control.color,
			background: style.backgroundColor,
			indicator,
			boxShadow: style.boxShadow
		};
	});

	await page.evaluate(() => {
		dispatch({ type: 'VERIFY_FORWARD' });
		dispatch({ type: 'NAVIGATE', view: 'settings' });
	});
	const disabled = await page.$eval('button[data-action="forward-enable"]:disabled', (element) => {
		const style = getComputedStyle(element);
		return { opacity: style.opacity, text: style.color, background: style.backgroundColor };
	});
	const samples = {
		normalText: { ...normal, ratio: ratio(normal.text, normal.background) },
		largeText: { ...large, ratio: ratio(large.text, large.background) },
		hover: { ...hover, ratio: ratio(hover.text, hover.background) },
		unread: { ...unread, ratio: ratio(unread.text, unread.background) },
		selected: {
			...selected,
			textRatio: ratio(selected.text, selected.background),
			indicatorRatio: ratio(selected.indicator, selected.background)
		},
		componentBoundary: { ...component, ratio: ratio(component.border, component.background) },
		focusIndicator: { ...focus, ratio: ratio(focus.border, focus.background) },
		disabled: { ...disabled, wcagContrastExempt: true },
		icons: iconSamples
	};
	for (const key of ['normalText', 'hover', 'unread'])
		assert.ok(
			samples[key].ratio >= 4.5,
			`${profile}/${theme}/${key} normal text contrast must be >= 4.5:1`
		);
	assert.ok(samples.largeText.ratio >= 3, `${profile}/${theme}/largeText contrast must be >= 3:1`);
	assert.ok(
		samples.selected.textRatio >= 4.5,
		`${profile}/${theme}/selected text contrast must be >= 4.5:1`
	);
	assert.ok(
		samples.selected.indicatorRatio >= 3,
		`${profile}/${theme}/selected indicator contrast must be >= 3:1`
	);
	assert.ok(
		samples.componentBoundary.ratio >= 3,
		`${profile}/${theme}/component boundary contrast must be >= 3:1`
	);
	assert.ok(
		samples.focusIndicator.ratio >= 3,
		`${profile}/${theme}/focus indicator contrast must be >= 3:1`
	);
	for (const [name, value] of Object.entries(samples.icons))
		assert.ok(
			value.ratio >= axeIncompleteReview.evidence.minimumRatio,
			`${profile}/${theme}/${name} non-text glyph contrast must be >= ${axeIncompleteReview.evidence.minimumRatio}:1`
		);
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

async function closeResources(phase, primaryError, steps) {
	let cleanupError = null;
	for (const [name, close] of steps) {
		try {
			await close();
		} catch (error) {
			cleanupError ||= error;
			log('cleanup-failure', { phase, resource: name, message: error.message });
		}
	}
	if (!primaryError && cleanupError) throw cleanupError;
}

async function runChromium() {
	const tracePath = path.join(artifacts, 'trace.zip');
	let browser;
	let context;
	let page;
	let traceStarted = false;
	let primaryError = null;
	try {
		browser = await chromium.launch({ headless: true });
		evidence.browserVersions.chromium = browser.version();
		referenceEnvironmentGuard(browser.version());
		prepareBaselineStaging();
		context = await newContext(browser, snapshotWidths[0]);
		await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
		traceStarted = true;
		page = await context.newPage();
		const pageErrors = [];
		page.on('pageerror', (error) => pageErrors.push(error.message));
		await openDemo(page);
		await assertAccessibleState(page);
		await assertOfflineState(page);

		for (const profile of profiles) {
			for (const theme of themes) {
				for (const state of axeStates) {
					for (const viewport of axeWidths) {
						currentCell = `chromium/${profile}/${theme}/${state}/${viewport.name}`;
						await page.setViewportSize({ width: viewport.width, height: viewport.height });
						await setScenario(page, { profile, theme, state });
						const label = `${profile}/${theme}/${state}/${viewport.name}`;
						const structure = await assertScenarioStructure(page, {
							profile,
							state,
							viewport,
							label
						});
						if (structure) evidence.scenarioStructures.push({ label, ...structure });
						const axe = await axeScan(page, label);
						evidence.axeCells.push(axe);
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
						if (viewport.name === 'mobile') {
							const mobile = { label, ...(await scanMobileTargets(page, label)) };
							evidence.mobileCells.push(mobile);
						}
					}
				}
			}
		}
		assert.equal(evidence.axeCells.length, 48, 'the full axe matrix must contain exactly 48 runs');

		for (const profile of profiles) {
			for (const theme of themes) {
				for (const viewport of snapshotWidths) {
					currentCell = `screenshot/${profile}/${theme}/${viewport.name}`;
					await page.setViewportSize({ width: viewport.width, height: viewport.height });
					await setScenario(page, { profile, theme, state: 'inbox' });
					const filename = `${profile}-${theme}-${viewport.name}.png`;
					const file = path.join(artifacts, 'screenshots', filename);
					await page.screenshot({
						path: file,
						fullPage: false,
						animations: 'disabled',
						caret: 'hide'
					});
					const comparison = compareBaseline(file, filename);
					evidence.screenshots.push({
						profile,
						theme,
						viewport: `${viewport.width}x${viewport.height}`,
						file,
						sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
						comparison
					});
				}
			}
		}
		assert.equal(
			evidence.screenshots.length,
			18,
			'the baseline comparison must contain exactly 18 files'
		);

		await page.setViewportSize({ width: 1440, height: 900 });
		for (const profile of profiles)
			for (const theme of themes)
				((currentCell = `contrast/${profile}/${theme}`),
					evidence.contrasts.push(await contrastRecord(page, profile, theme)));
		for (const profile of profiles) {
			currentCell = `keyboard/${profile}`;
			await keyboardFlow(page, profile);
			await restorationAndAnchor(page, profile);
			await reducedMotionCheck(page, profile);
		}
		assert.deepEqual(pageErrors, [], 'Chromium must report zero page errors');
		return { tracePath };
	} catch (error) {
		primaryError = error;
		evidence.failedCell ||= currentCell;
		if (page) {
			const failureFile = path.join(artifacts, 'failure.png');
			await page.screenshot({ path: failureFile, fullPage: false }).then(
				() => {
					evidence.failureScreenshot = { cell: evidence.failedCell, file: failureFile };
				},
				() => undefined
			);
		}
		throw error;
	} finally {
		await closeResources('chromium', primaryError, [
			...(context && traceStarted
				? [['trace', () => context.tracing.stop({ path: tracePath })]]
				: []),
			...(context ? [['context', () => context.close()]] : []),
			...(browser ? [['browser', () => browser.close()]] : [])
		]);
	}
}

async function runBrowserSmoke(name, browserType) {
	let browser;
	let context;
	let primaryError = null;
	try {
		browser = await browserType.launch({ headless: true });
		evidence.browserVersions[name] = browser.version();
		context = await newContext(browser, axeWidths[1]);
		const page = await context.newPage();
		await openDemo(page);
		const results = [];
		for (const profile of profiles) {
			for (const viewport of axeWidths) {
				currentCell = `${name}/${profile}/dark/inbox/${viewport.name}`;
				await page.setViewportSize({ width: viewport.width, height: viewport.height });
				await setScenario(page, { profile, theme: 'dark', state: 'inbox' });
				const label = `${name}/${profile}/dark/inbox/${viewport.name}`;
				const axe = await axeScan(page, label);
				const overflow = await page.evaluate(() => ({
					viewport: innerWidth,
					document: document.documentElement.scrollWidth,
					body: document.body.scrollWidth
				}));
				assert.ok(
					overflow.document <= overflow.viewport + 0.5 && overflow.body <= overflow.viewport + 0.5,
					`${label} must not overflow horizontally`
				);
				const mobile = viewport.name === 'mobile' ? await scanMobileTargets(page, label) : null;
				await setScenario(page, { profile, theme: 'dark', state: 'selected' });
				const structure = await assertScenarioStructure(page, {
					profile,
					state: 'selected',
					viewport,
					label
				});
				await page.evaluate(() => dispatch({ type: 'OPEN_COMPOSE', mode: 'new' }));
				assert.equal(
					await page.locator('[data-compose="from"]').count(),
					1,
					`${label} must open compose`
				);
				results.push({
					label,
					profile,
					viewport: viewport.name,
					axe,
					overflow,
					mobile,
					structure,
					compose: true
				});
			}
		}
		evidence.browserCells[name] = results;
		return results;
	} catch (error) {
		primaryError = error;
		evidence.failedCell ||= currentCell;
		throw error;
	} finally {
		await closeResources(name, primaryError, [
			...(context ? [['context', () => context.close()]] : []),
			...(browser ? [['browser', () => browser.close()]] : [])
		]);
	}
}

let failure = null;
let tracePath = path.join(artifacts, 'trace.zip');
let baselineUpdate = null;
let visualCandidatePath = null;
let voiceOverCandidatePath = null;
try {
	preflight();
	const chromiumResult = await runChromium();
	tracePath = chromiumResult.tracePath;
	await runBrowserSmoke('firefox', firefox);
	await runBrowserSmoke('webkit', webkit);
	if (updateBaselines) {
		assert.deepEqual(evidence.browserVersions, {
			chromium: expectedReferenceEnvironment.chromium,
			firefox: expectedReferenceEnvironment.firefox,
			webkit: expectedReferenceEnvironment.webkit
		});
	}
	visualCandidatePath = writeVisualReviewCandidate(
		updateBaselines ? assertBaselineStaging() : baselineDirectory
	);
	voiceOverCandidatePath = writeVoiceOverReviewCandidate();
	baselineUpdate = finalizeBaselineUpdate();
} catch (error) {
	failure = error;
	evidence.failedCell ||= currentCell;
	evidence.errors.push({
		cell: evidence.failedCell,
		name: error.name,
		message: error.message,
		stack: error.stack
	});
	fs.writeFileSync(path.join(artifacts, 'failure.log'), `${error.stack || error.message}\n`);
} finally {
	try {
		const flowLogPath = path.join(artifacts, 'ui-flow-log.json');
		fs.writeFileSync(flowLogPath, JSON.stringify(flowLog, null, 2) + '\n');
		const manifest = {
			status: failure ? 'FAIL_AUTOMATED' : 'PASS_AUTOMATED_VOICEOVER_PENDING',
			generatedAtFixtureClock: fixedClock,
			environment: {
				locale: 'ja-JP',
				timezone: 'Asia/Tokyo',
				deviceScaleFactor: 1,
				platform: process.platform,
				arch: process.arch,
				osRelease: os.release(),
				node: process.version,
				pinnedReferenceContainer: pinnedContainer,
				pinnedContainerTag,
				pinnedImageDigest,
				baselineVersion,
				baselineMode,
				allowedMismatchRatio,
				updateBaselines
			},
			identity: {
				commit: gitCommit(),
				package: JSON.parse(
					fs.readFileSync(path.resolve(directory, '../..', 'package.json'), 'utf8')
				).version,
				dependencies: {
					playwright: dependencyVersion('playwright'),
					axeCorePlaywright: dependencyVersion('@axe-core/playwright'),
					pixelmatch: dependencyVersion('pixelmatch'),
					pngjs: dependencyVersion('pngjs')
				},
				browsers: evidence.browserVersions
			},
			matrix: {
				axe: { expected: 48, completed: evidence.axeCells.length, cells: evidence.axeCells },
				mobile: {
					expected: 24,
					completed: evidence.mobileCells.length,
					cells: evidence.mobileCells
				},
				selectedScenarios: evidence.scenarioStructures,
				browserSmoke: evidence.browserCells
			},
			screenshots: {
				expected: 18,
				completed: evidence.screenshots.length,
				cells: evidence.screenshots
			},
			contrasts: evidence.contrasts,
			errors: evidence.errors,
			failedCell: evidence.failedCell,
			failureScreenshot: evidence.failureScreenshot,
			baselineUpdate,
			artifacts: {
				directory: artifacts,
				trace: fs.existsSync(tracePath) ? tracePath : null,
				screenshots: path.join(artifacts, 'screenshots'),
				diffs: fs.existsSync(path.join(artifacts, 'diffs')) ? path.join(artifacts, 'diffs') : null,
				failureLog: failure ? path.join(artifacts, 'failure.log') : null,
				uiFlowLog: flowLogPath
			},
			visualReview: {
				status: 'PENDING_HUMAN_REVIEW',
				receiptSchema: path.join(directory, 'baseline-review-receipt.schema.json'),
				candidate: visualCandidatePath
			},
			voiceOver: {
				status: 'UNVERIFIED_HUMAN_GATE',
				checklist: path.join(directory, 'VOICEOVER-CHECKLIST.md'),
				receiptSchema: path.join(directory, 'voiceover-review-receipt.schema.json'),
				candidate: voiceOverCandidatePath
			}
		};
		fs.writeFileSync(
			path.join(artifacts, 'manifest.json'),
			JSON.stringify(manifest, null, 2) + '\n'
		);
		console.log(JSON.stringify(manifest, null, 2));
	} finally {
		cleanupBaselineStaging();
	}
}

if (failure) throw failure;
