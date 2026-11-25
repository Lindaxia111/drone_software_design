/** Start a test-only API+Worker with DRONE_LAB_DB=tmp/core-browser.sqlite3, then run:
 * BASE_URL=http://127.0.0.1:8020 node tests/browser-core.cjs
 * Uses the existing Playwright install and local Chrome, no runtime dependency changes.
 */
const { chromium, expect } = require('../apps/web/node_modules/@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const base = process.env.BASE_URL || 'http://127.0.0.1:8020';
  const browser = await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context = await browser.newContext({viewport:{width:1500,height:1080},acceptDownloads:true});
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  const folder=path.resolve('tmp/core-screenshots'); fs.mkdirSync(folder,{recursive:true});
  // Use a fresh seed so the first run records actual attempts even with a warm cache.
  const seed = Date.now() % 2147483647;
  try {
    await page.goto(base);
    await expect(page.locator('.connection')).toContainText('服务已连接');
    await page.getByRole('button',{name:'新建实验',exact:true}).last().click();
    await page.getByLabel('实验名称').fill('核心整合 · 参数与暂停验收');
    await page.getByText('高级物理与算法配置', {exact:false}).first().click();
    await page.getByLabel('搜索代数').fill('2');
    await page.getByLabel('每代候选数').fill('4');
    await page.getByLabel('测试时长 / s',{exact:true}).fill('2');
    await page.getByLabel('随机种子',{exact:true}).fill(String(seed));
    await page.getByRole('button',{name:'创建后暂不启动'}).click();
    await expect(page.locator('.experiment-title .badge')).toHaveText('已暂停');
    await expect(page.getByRole('button',{name:'暂停计算',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:/场景配置/}).click();
    await expect(page.getByRole('dialog')).toContainText(String(seed));
    await expect(page.getByRole('dialog')).toContainText('三维飞行模拟');
    await page.getByRole('button',{name:'关闭详情'}).click();
    await page.getByRole('button',{name:'启动实验',exact:true}).click();
    await expect(page.getByRole('button',{name:'暂停计算',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'暂停计算',exact:true}).click();
    await expect(page.locator('.experiment-title .badge')).toHaveText('已暂停');
    await page.reload();
    await expect(page.locator('.experiment-title .badge')).toHaveText('已暂停');
    await page.getByRole('button',{name:/^(启动实验|继续运行)$/}).click();
    await expect(page.locator('.experiment-title .badge')).toHaveText('已完成',{timeout:40000});
    await expect(page.getByRole('button',{name:'对比优选方案',exact:true})).toBeEnabled();
    await expect(page.getByRole('button',{name:'查看参数',exact:true})).toHaveCount(8);
    const firstRow=page.locator('tbody tr').filter({has:page.locator('.badge.passed')}).first();
    await firstRow.getByRole('button',{name:'查看参数'}).click();
    await expect(page.getByRole('dialog')).toContainText('电池与载荷');
    await expect(page.getByRole('dialog')).toContainText('旋翼参数');
    await page.screenshot({path:path.join(folder,'candidate-parameters.png')});
    await page.getByRole('tab',{name:'评估记录',exact:true}).click();
    const evaluationDialog = page.getByRole('dialog');
    await expect(evaluationDialog).toContainText('三维动力学模拟');
    await expect(evaluationDialog.getByRole('heading',{name:'执行尝试'})).toBeVisible();
    await expect(evaluationDialog.locator('.attempt-timeline li').first()).toContainText('结束时间');
    await expect(evaluationDialog.getByRole('table',{name:/运行时解析参数/})).toHaveCount(2);
    await expect(evaluationDialog.locator('.evaluation-card').last()).toContainText('目标适应度评分');
    await page.getByRole('tab',{name:'测试条件',exact:true}).click();
    await expect(page.getByRole('dialog')).toContainText(String(seed));
    await page.getByRole('tab',{name:'轨迹',exact:true}).click();
    await expect(page.getByRole('slider',{name:'轨迹时间'})).toBeVisible();
    await page.getByRole('slider',{name:'轨迹时间'}).fill('10');
    await page.screenshot({path:path.join(folder,'trajectory.png')});
    await page.getByRole('button',{name:'关闭详情'}).click();
    await page.locator('.experiment-menu summary').click();
    const downloading=page.waitForEvent('download');
    await page.getByRole('link',{name:'导出报告'}).click();
    const reportFile=path.join(folder,'report.json'); await (await downloading).saveAs(reportFile);
    const report=JSON.parse(fs.readFileSync(reportFile,'utf8'));
    expect(report.verification_level).toBe('DYNAMICS');
    for (const candidate of report.experiment.candidates) {
      const response=await context.request.get(`${base}/api/experiments/${report.experiment.id}/candidates/${candidate.candidate_id}`);
      expect(response.status()).toBe(200);
      const detail=await response.json();
      expect(detail.candidate.ir_hash).toBe(candidate.ir_hash);
      expect(detail.candidate.ir).toEqual(candidate.ir);
      expect(detail.request.seed).toBe(seed);
    }
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(folder,'desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(folder,'mobile.png'),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole('button',{name:/场景配置/}).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:path.join(folder,'mobile-parameters.png')});
    await page.getByRole('button',{name:'关闭详情'}).click();
    await page.locator('.experiment-menu summary').click();
    const retrying=page.waitForResponse(r=>r.url().endsWith('/retry')&&r.request().method()==='POST');
    await page.getByRole('button',{name:'重新测试',exact:true}).click();
    const retry=await (await retrying).json();
    expect(retry.id).not.toBe(report.experiment.id);
    await expect.poll(async()=>{
      const response=await context.request.get(`${base}/api/experiments/${retry.id}`);
      return (await response.json()).status;
    },{timeout:30000}).toBe('COMPLETED');
    const cached=await (await context.request.get(`${base}/api/experiments/${retry.id}`)).json();
    expect(cached.l1_used).toBe(0);expect(cached.l2_used).toBe(0);
    expect(cached.cache_hits).toBeGreaterThan(0);expect(errors).toEqual([]);
    console.log(JSON.stringify({passed:true,candidates:report.experiment.candidates.length,feasible:report.experiment.passed,cache_hits:cached.cache_hits,screenshots:folder}));
  } catch(e) {
    console.error('Browser errors:',errors);
    await page.screenshot({path:path.join(folder,'failure.png'),fullPage:true}).catch(()=>{});
    throw e;
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
