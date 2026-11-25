/**
 * Start a test-only API and Worker first (DRONE_LAB_DB=tmp/browser.sqlite3).
 * npm install --prefix apps/web --no-save --package-lock=false @playwright/test@1.49.1
 * node tests/browser-smoke.cjs
 * Uses installed Chrome, or CHROME_PATH; BASE_URL defaults to http://127.0.0.1:8000.
 * All created experiments are retained in that test database. No production data deleted.
 */
const { chromium, expect } = require('../apps/web/node_modules/@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const base = process.env.BASE_URL || 'http://127.0.0.1:8000';
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
  const context = await browser.newContext({viewport: {width: 1500, height: 1080}, acceptDownloads: true});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const folder = path.resolve('tmp/screenshots');
  fs.mkdirSync(folder, {recursive: true});
  try {
    await page.goto(base);
    await expect(page.locator('.connection')).toContainText('服务已连接');
    await page.getByRole('button', {name:'新建实验', exact:true}).last().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByLabel('实验名称').fill('浏览器验收 · 基准实验');
    await page.getByLabel('评估模式').selectOption('demo');
    await page.getByText('高级物理与算法配置', {exact:false}).first().click();
    await page.getByLabel('寻优算法').selectOption('random');
    await page.getByLabel('搜索代数').fill('3');
    await page.getByLabel('每代候选数').fill('8');
    await page.getByRole('button', {name:'创建并运行'}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.experiment-title h2')).toHaveText('浏览器验收 · 基准实验');
    await page.getByRole('button', {name:'暂停计算', exact:true}).click();
    await expect(page.locator('.experiment-title .badge')).toHaveText('已暂停');
    await page.getByRole('button', {name:/^(启动实验|继续运行)$/}).click();
    await expect(page.locator('.experiment-title .badge')).toHaveText('已完成', {timeout:30000});
    await expect(page.locator('tbody tr:not(.violation-row)')).toHaveCount(24);
    await expect(page.locator('.pareto-label').first()).toBeVisible();
    await expect(page.locator('.stat-card').nth(1).locator('strong')).toContainText('min');
    await expect(page.locator('.stat-card').nth(2).locator('strong')).toContainText('m');
    await page.locator('.experiment-menu summary').click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', {name:'导出报告'}).click();
    const download = await downloadPromise;
    const reportPath=path.join(folder, 'browser-report.json');
    await download.saveAs(reportPath);
    const report=JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(report.verification_level).toBe('DEMO');
    expect(report.experiment.passed).toBeGreaterThan(0);
    expect(report.experiment.candidates.length).toBe(24);
    const first=report.experiment;
    const irPromise=page.waitForEvent('download');
    await page.getByRole('link', {name:'导出机型配置'}).click();
    await (await irPromise).saveAs(path.join(folder, 'browser-drone.json'));
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(folder,'desktop.png'), fullPage:true});
    // A second identical request exercises actual cross-experiment cache via the API.
    const created=await context.request.post(`${base}/api/experiments`,{data:first.request});
    expect(created.status()).toBe(201);
    const second=await created.json();
    await expect.poll(async()=>{
      const r=await context.request.get(`${base}/api/experiments/${second.id}`);
      return (await r.json()).status;
    }, {timeout:30000}).toBe('COMPLETED');
    const secondDetail=await (await context.request.get(`${base}/api/experiments/${second.id}`)).json();
    expect(secondDetail.l1_used).toBe(0);
    expect(secondDetail.l2_used).toBe(0);
    expect(secondDetail.cache_hits).toBeGreaterThan(24);
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(folder,'mobile.png'),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    console.log(JSON.stringify({passed:true,candidates:first.candidates.length,feasible:first.passed,cache_hits:secondDetail.cache_hits,screenshots:folder}));
  } catch (error) {
    await page.screenshot({path:path.join(folder,'failure.png'),fullPage:true}).catch(()=>{});
    console.error('Browser errors:', errors);
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
